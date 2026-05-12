/**
 * IronShield Pool Scanner (The Filter - Module 1a)
 * Scans Base chain DEX liquidity pools for arbitrage opportunities
 * Identifies price discrepancies across Aerodrome, Uniswap V3, BaseSwap
 */
import { ethers, Contract } from "ethers";
import { createModuleLogger } from "../utils/logger";
import { ADDRESSES, SCANNER, EXECUTION, DexId, UniV3Fee, SwapStep, ArbitragePath } from "../config/config";

const log = createModuleLogger("SCANNER");

/**
 * [v3.1] Stagger delay — tiny sleep between requests in a batch
 * to prevent instantaneous RPS spikes at the RPC provider.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── ABI Fragments ────────────────────────────────────────────
const UNISWAP_V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
];

const UNISWAP_V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
];

const AERODROME_POOL_ABI = [
  "function reserves() view returns (uint256 reserve0, uint256 reserve1)",
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
];

const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
];

const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";

const AERODROME_FACTORY_ABI = [
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256 index) view returns (address)",
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
  "function getPair(address tokenA, address tokenB) view returns (address)", // Added for UniV2 forks
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

// ── Pool Info Types ──────────────────────────────────────────
interface PoolInfo {
  address: string;
  dexId: DexId;
  token0: string;
  token1: string;
  tokenA: string; // Base token (unit)
  tokenB: string; // Quote token
  reserve0: bigint;
  reserve1: bigint;
  fee: number;
  stable?: boolean;
  price: number; // Strictly TokenB / TokenA
  liquidityUSD: number;
  extraData?: string;
}

interface PriceDiscrepancy {
  tokenA: string;
  tokenB: string;
  symbolA: string;
  symbolB: string;
  pools: PoolInfo[];
  maxSpread: number; // percentage
  bestBuyPool: PoolInfo;
  bestSellPool: PoolInfo;
}

export class PoolScanner {
  private provider: ethers.JsonRpcProvider;
  private uniV3Factory: Contract;
  private aeroFactory: Contract;
  private baseSwapFactory: Contract;
  private knownTokens: Map<string, { symbol: string; decimals: number }> = new Map();
  private discoveredPools: Map<string, PoolInfo> = new Map();

  // 1. 新增輪詢狀態
  private rotationIndex = 0;
  private readonly ROTATION_SIZE = 12; // [v4.2] Expanded rotation to 12 assets to ensure variety
  private poolAddressCache: Map<string, PoolInfo[]> = new Map();

  constructor(provider: ethers.JsonRpcProvider) {
    this.provider = provider;
    this.uniV3Factory = new Contract(
      ADDRESSES.UNISWAP_V3_FACTORY,
      UNISWAP_V3_FACTORY_ABI,
      provider
    );
    this.aeroFactory = new Contract(
      ADDRESSES.AERODROME_FACTORY,
      AERODROME_FACTORY_ABI,
      provider
    );
    this.baseSwapFactory = new Contract(
      ADDRESSES.BASESWAP_FACTORY,
      AERODROME_FACTORY_ABI, // BaseSwap uses UniV2 style factory
      provider
    );

    // Pre-populate known tokens
    // Pre-populate known tokens with lowercase addresses for robust matching
    this.knownTokens.set(ADDRESSES.WETH.toLowerCase(), { symbol: "WETH", decimals: 18 });
    this.knownTokens.set(ADDRESSES.USDC.toLowerCase(), { symbol: "USDC", decimals: 6 });
    this.knownTokens.set(ADDRESSES.USDbC.toLowerCase(), { symbol: "USDbC", decimals: 6 });
    this.knownTokens.set(ADDRESSES.DAI.toLowerCase(), { symbol: "DAI", decimals: 18 });
    this.knownTokens.set("0x940181a94A35A4569E4529A3CDfB74e38FD98631".toLowerCase(), { symbol: "AERO", decimals: 18 });
    this.knownTokens.set("0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b".toLowerCase(), { symbol: "VIRTUAL", decimals: 18 });
    this.knownTokens.set("0xcB7C0000aB88B473B1f5AfD9Ef808440eeD33Bf".toLowerCase(), { symbol: "cbBTC", decimals: 8 });
    this.knownTokens.set("0x4ed4e862860bed51a9570b96d89af5e1b0efefed".toLowerCase(), { symbol: "DEGEN", decimals: 18 });
    this.knownTokens.set("0x532f27101965dd16442e59d40670faf5ebb142e4".toLowerCase(), { symbol: "BRETT", decimals: 18 });
    this.knownTokens.set("0xAC1Bd2465aA515910006945042443b961c7c0146".toLowerCase(), { symbol: "TOSHI", decimals: 18 });
    this.knownTokens.set("0x05767d9Ef41Dc40689678fFca0608878fb3dE906".toLowerCase(), { symbol: "HIGHER", decimals: 18 });
    this.knownTokens.set("0x9D092780e037f6aB5812B7D034346899E054e04f".toLowerCase(), { symbol: "KEYCAT", decimals: 18 });
  }

  /**
   * [v3.1] Scan for cross-DEX price discrepancies.
   * Uses chunked processing to prevent RPS bursts.
   * Token pairs are processed in batches of POOL_SCAN_CHUNK_SIZE.
   */
  async scanForOpportunities(): Promise<PriceDiscrepancy[]> {
    log.info("🔍 Starting pool scan cycle...");
    const discrepancies: PriceDiscrepancy[] = [];
    const allSpreads: { symbolA: string, symbolB: string, spread: number }[] = [];

    try {
      const blockNumber = await this.provider.getBlockNumber();
      const tokenPairs = this.generateTokenPairs();
      
      const pairsLabels = tokenPairs.map(([a, b]) => {
        const sA = this.knownTokens.get(a.toLowerCase())?.symbol || a.slice(0, 6);
        const sB = this.knownTokens.get(b.toLowerCase())?.symbol || b.slice(0, 6);
        return `${sA}/${sB}`;
      }).join(", ");

      log.info(`🔍 Scan Cycle | Block: ${blockNumber} | Scanning: ${pairsLabels}`);

      // [v3.1] Process token pairs in chunks to avoid RPS spikes.
      // Without chunking, scanning 10 pairs × 2 DEXes = 20+ concurrent eth_calls,
      // which instantly exceeds QuickNode's 10 RPS limit.
      // [v3.2] Pool Address Cache to reduce RPC pressure
      if (!this.poolAddressCache) {
        this.poolAddressCache = new Map<string, any[]>();
      }

      let bestSpreadFound = 0;
      let bestPairLabel = "None";

      for (let i = 0; i < tokenPairs.length; i += SCANNER.POOL_SCAN_CHUNK_SIZE) {
        const chunk = tokenPairs.slice(i, i + SCANNER.POOL_SCAN_CHUNK_SIZE);
        const progress = Math.min(i + SCANNER.POOL_SCAN_CHUNK_SIZE, tokenPairs.length);
        log.debug(`⏳ Processing pairs ${i + 1}-${progress} of ${tokenPairs.length}...`);

        const chunkResults = await Promise.all(
          chunk.map(async ([tokenA, tokenB], idx) => {
            try {
              if (idx > 0) {
                await sleep(SCANNER.POOL_SCAN_JITTER_MS * idx);
              }

              const pairKey = [tokenA, tokenB].sort().join("-");
              let pools;

              if (this.poolAddressCache.has(pairKey)) {
                const cachedPools = this.poolAddressCache.get(pairKey)!;
                pools = await this.updatePoolsBatch(cachedPools, tokenA, tokenB);
              } else {
                pools = await this.getPoolsForPair(tokenA, tokenB);
                this.poolAddressCache.set(pairKey, pools);
              }

              return { tokenA, tokenB, pools };
            } catch (err: any) {
              log.warn(`   ⚠️ Skipping pair ${tokenA.slice(0, 6)} due to RPC error: ${err.message}`);
              return { tokenA, tokenB, pools: [] };
            }
          })
        );

        for (const { tokenA, tokenB, pools } of chunkResults) {
          if (pools.length < 2) continue;
          const prices = pools.map((p) => p.price).filter((p) => p > 0);
          if (prices.length < 2) continue;

          const maxPrice = Math.max(...prices);
          const minPrice = Math.min(...prices);
          const spread = ((maxPrice - minPrice) / minPrice) * 100;

          const sA = await this.getTokenSymbol(tokenA);
          const sB = await this.getTokenSymbol(tokenB);
          allSpreads.push({ symbolA: sA, symbolB: sB, spread });

          if (spread > bestSpreadFound) {
            bestSpreadFound = spread;
            bestPairLabel = `${sA}/${sB}`;
          }

          const bestBuy = pools.reduce((a, b) => (a.price < b.price ? a : b));
          const bestSell = pools.reduce((a, b) => (a.price > b.price ? a : b));
          const getFeePct = (pool: any) => pool.dexId === DexId.UNISWAP_V3 ? pool.fee / 10000 : pool.fee / 100;
          const totalFeesPct = getFeePct(bestBuy) + getFeePct(bestSell);
          const netSpread = spread - totalFeesPct;

          if (netSpread >= SCANNER.MIN_SPREAD_PCT) {
            const symbolA = await this.getTokenSymbol(tokenA);
            const symbolB = await this.getTokenSymbol(tokenB);
            discrepancies.push({
              tokenA, tokenB, symbolA, symbolB, pools,
              maxSpread: spread, bestBuyPool: bestBuy, bestSellPool: bestSell,
            });

            log.info(
              `🎯 Spread found: ${symbolA}/${symbolB} = ${spread.toFixed(2)}% across ${pools.length} pools`,
              { buyDex: DexId[bestBuy.dexId], sellDex: DexId[bestSell.dexId] }
            );
          }
        }
        
        if (i + SCANNER.POOL_SCAN_CHUNK_SIZE < tokenPairs.length) {
          await sleep(SCANNER.POOL_SCAN_JITTER_MS);
        }
      }

      // Summarize Top 3 absolute spreads found this cycle
      const top3Absolute = allSpreads.sort((a, b) => b.spread - a.spread).slice(0, 3);
      const topLabels = top3Absolute.length > 0 
        ? top3Absolute.map(t => `${t.symbolA}/${t.symbolB} (Gross: ${t.spread.toFixed(3)}%)`).join(", ")
        : "None";

      log.info(`✅ Scan complete: ${discrepancies.length} opportunities. Top spreads: ${topLabels}`);
    } catch (error: any) {
      log.error(`Scan failed: ${error.message}`);
    }

    return discrepancies.sort((a, b) => b.maxSpread - a.maxSpread);
  }

  /**
   * Build arbitrage paths from discrepancies
   */
  async buildArbitragePaths(discrepancies: PriceDiscrepancy[]): Promise<ArbitragePath[]> {
    const paths: ArbitragePath[] = [];

    for (const disc of discrepancies) {
      const firstPool = disc.bestBuyPool;
      const reserveIn = firstPool.token0.toLowerCase() === disc.tokenA.toLowerCase()
        ? firstPool.reserve0
        : firstPool.reserve1;

      // [v4.0 UPGRADE] Increased Loan Capacity: 15% of reserves
      let loanAmount = (reserveIn * 15n) / 100n; 

      // Safety: cap by DEFAULT_LOAN_AMOUNT if reserve is huge, but ensure it's not 0
      if (loanAmount > EXECUTION.DEFAULT_LOAN_AMOUNT) {
        loanAmount = EXECUTION.DEFAULT_LOAN_AMOUNT;
      }
      if (loanAmount === 0n) loanAmount = ethers.parseUnits("0.01", 18); // Minimum floor

      // Two-hop: WETH -> Token (buy cheap) -> WETH (sell expensive)
      const twoHopPath: ArbitragePath = {
        id: `${disc.symbolA}-${disc.symbolB}-2hop-${Date.now()}`,
        steps: [
          {
            dexId: disc.bestBuyPool.dexId,
            tokenIn: disc.tokenA,
            tokenOut: disc.tokenB,
            amountIn: 0n, // Will be set to loanAmount by pathOptimizer
            fee: disc.bestBuyPool.fee,
            extraData: disc.bestBuyPool.stable !== undefined
              ? ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [disc.bestBuyPool.stable])
              : "0x",
            poolAddress: disc.bestBuyPool.address,
          },
          {
            dexId: disc.bestSellPool.dexId,
            tokenIn: disc.tokenB,
            tokenOut: disc.tokenA,
            amountIn: 0n, // Use full balance from previous step
            fee: disc.bestSellPool.fee,
            extraData: disc.bestSellPool.stable !== undefined
              ? ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [disc.bestSellPool.stable])
              : "0x",
            poolAddress: disc.bestSellPool.address,
          },
        ],
        loanAmount: loanAmount,
        assetPriceUSD: await this.getBasePrice(disc.tokenA, disc.bestBuyPool),
        estimatedProfit: 0n,
        estimatedGas: 0n,
        profitUSD: 0,
        confidence: 0,
        timestamp: Date.now(),
      };

      paths.push(twoHopPath);
    }

    return paths;
  }

  /**
   * Scan Aerodrome pools for a token pair
   */
  private async getAerodromePools(
    tokenA: string,
    tokenB: string
  ): Promise<PoolInfo[]> {
    const pools: PoolInfo[] = [];

    for (const stable of [false, true]) {
      try {
        // [v4.3] Sort tokens to ensure factory compatibility
        const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() 
          ? [tokenA, tokenB] 
          : [tokenB, tokenA];

        const poolAddr = await this.aeroFactory.getPool(t0, t1, stable);
        if (poolAddr === ethers.ZeroAddress) continue;

        const pool = new Contract(poolAddr, AERODROME_POOL_ABI, this.provider);
        const [reserves, token0] = await Promise.all([
          pool.getReserves(),
          pool.token0(),
        ]);

        const reserve0 = reserves[0];
        const reserve1 = reserves[1];

        if (reserve0 === 0n || reserve1 === 0n) continue;

        const dec0 = await this.getTokenDecimals(token0);
        const dec1 = await this.getTokenDecimals(
          token0.toLowerCase() === tokenA.toLowerCase() ? tokenB : tokenA
        );

        // [v3.3 Fix] Use unified price calculation to ensure TokenB/TokenA
        const price = await this.calculateAeroPrice(
          reserve0,
          reserve1,
          token0,
          token0.toLowerCase() === tokenA.toLowerCase() ? tokenB : tokenA,
          tokenA,
          tokenB,
          stable
        );

        pools.push({
          address: poolAddr,
          dexId: DexId.AERODROME,
          token0: token0,
          token1: token0.toLowerCase() === tokenA.toLowerCase() ? tokenB : tokenA,
          tokenA,
          tokenB,
          reserve0,
          reserve1,
          fee: stable ? 1 : 30, // 0.01% stable, 0.3% volatile
          stable,
          price,
          extraData: ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [stable]),
          liquidityUSD: 0, // Will be calculated later
        });
      } catch (e: any) {
        log.debug(`      ❌ Aerodrome scan error for ${tokenA.slice(0, 6)}/${tokenB.slice(0, 6)}: ${e.message}`);
      }
    }

    return pools;
  }

  /**
   * Scan Uniswap V3 pools for a token pair across fee tiers
   */
  private async getUniV3Pools(
    tokenA: string,
    tokenB: string
  ): Promise<PoolInfo[]> {
    const pools: PoolInfo[] = [];
    const feeTiers = [UniV3Fee.LOW, UniV3Fee.MEDIUM, UniV3Fee.HIGH];

    for (const fee of feeTiers) {
      try {
        const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() 
          ? [tokenA, tokenB] 
          : [tokenB, tokenA];

        const poolAddr = await this.uniV3Factory.getPool(t0, t1, fee);
        if (poolAddr === ethers.ZeroAddress) continue;

        const pool = new Contract(poolAddr, UNISWAP_V3_POOL_ABI, this.provider);
        const [slot0, liquidity, token0] = await Promise.all([
          pool.slot0(),
          pool.liquidity(),
          pool.token0(),
        ]);

        if (liquidity === 0n) continue;

        const sqrtPriceX96 = slot0[0];
        const dec0 = await this.getTokenDecimals(token0);
        const token1 =
          token0.toLowerCase() === tokenA.toLowerCase() ? tokenB : tokenA;
        const dec1 = await this.getTokenDecimals(token1);

        // [v3.3 Fix] Pass tokenA and tokenB to ensure correct price direction
        const price = await this.calculateUniV3Price(sqrtPriceX96, token0, token1, tokenA, tokenB);

        pools.push({
          address: poolAddr,
          dexId: DexId.UNISWAP_V3,
          token0: token0,
          token1: token1,
          tokenA,
          tokenB,
          reserve0: liquidity, // Using liquidity as proxy
          reserve1: liquidity,
          fee,
          price,
          liquidityUSD: 0,
        });
      } catch (e) {
        // Pool doesn't exist for this fee tier
      }
    }

    return pools;
  }

  /**
   * [v3.1] Get all pools for a token pair across all DEXes.
   * Uses SEQUENTIAL calls instead of Promise.all to prevent
   * firing 2+ concurrent eth_calls per pair.
   */
  private async getPoolsForPair(
    tokenA: string,
    tokenB: string
  ): Promise<PoolInfo[]> {
    // Sequential: Aerodrome first, then Uniswap V3.
    // Each DEX query internally makes 2-3 eth_calls.
    // Running them in parallel would double the instantaneous RPS.
    const aeroPools = await this.getAerodromePools(tokenA, tokenB);
    await sleep(SCANNER.POOL_SCAN_JITTER_MS);
    const uniPools = await this.getUniV3Pools(tokenA, tokenB);
    await sleep(SCANNER.POOL_SCAN_JITTER_MS);
    const baseSwapPools = await this.getBaseSwapPools(tokenA, tokenB);

    if (aeroPools.length + uniPools.length + baseSwapPools.length === 0) {
      const sA = this.knownTokens.get(tokenA)?.symbol || tokenA.slice(0, 6);
      const sB = this.knownTokens.get(tokenB)?.symbol || tokenB.slice(0, 6);
      log.warn(`No pools found for pair: ${sA}-${sB}`);
    }

    return [...aeroPools, ...uniPools, ...baseSwapPools];
  }

  /**
   * Scan BaseSwap pools (UniV2 fork)
   */
  private async getBaseSwapPools(tokenA: string, tokenB: string): Promise<PoolInfo[]> {
    try {
      const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() 
        ? [tokenA, tokenB] 
        : [tokenB, tokenA];

      const poolAddr = await this.baseSwapFactory.getPair(t0, t1);
      if (poolAddr === ethers.ZeroAddress) return [];

      const pool = new Contract(poolAddr, AERODROME_POOL_ABI, this.provider);
      const [reserves, token0] = await Promise.all([
        pool.getReserves(),
        pool.token0(),
      ]);

      if (reserves[0] === 0n || reserves[1] === 0n) return [];

      const price = await this.calculateAeroPrice(
        reserves[0], reserves[1], token0, 
        token0.toLowerCase() === tokenA.toLowerCase() ? tokenB : tokenA,
        tokenA, tokenB, false
      );

      return [{
        address: poolAddr,
        dexId: DexId.BASESWAP,
        token0,
        token1: token0.toLowerCase() === tokenA.toLowerCase() ? tokenB : tokenA,
        tokenA, tokenB,
        reserve0: reserves[0], reserve1: reserves[1],
        fee: 25, // 0.25% fee
        price,
        liquidityUSD: 0
      }];
    } catch (e: any) { 
      log.debug(`      ❌ BaseSwap scan error for ${tokenA.slice(0, 6)}/${tokenB.slice(0, 6)}: ${e.message}`);
      return []; 
    }
  }

  /**
   * Generate token pairs to scan
   * Mixes core fixed pairs with rotating long-tail assets
   */
  private generateTokenPairs(): [string, string][] {
    const pairs: [string, string][] = [];

    // 【固定掃描】核心幣對：每一輪必掃
    pairs.push([ADDRESSES.WETH, ADDRESSES.USDC]);
    pairs.push([ADDRESSES.USDC, ADDRESSES.USDbC]);

    // 【輪詢掃描】長尾代幣：每一輪換 5 個
    const extended = ADDRESSES.EXTENDED_WHITELIST || [];
    if (extended.length > 0) {
      const scanCount = Math.min(this.ROTATION_SIZE, extended.length);
      for (let i = 0; i < scanCount; i++) {
        const targetToken = extended[(this.rotationIndex + i) % extended.length];
        pairs.push([ADDRESSES.WETH, targetToken]);
      }

      // 更新指針，下一輪從新位置開始
      this.rotationIndex = (this.rotationIndex + scanCount) % extended.length;
    }

    return pairs;
  }

  /**
   * [v4.0] Batch update pool data using Multicall3
   * Collapses N requests into 1 single eth_call.
   */
  private async updatePoolsBatch(
    pools: PoolInfo[],
    tokenA: string,
    tokenB: string
  ): Promise<PoolInfo[]> {
    if (pools.length === 0) return [];

    try {
      const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, this.provider);
      const calls: any[] = [];
      const poolInterfaceAero = new ethers.Interface(AERODROME_POOL_ABI);
      const poolInterfaceUni = new ethers.Interface(UNISWAP_V3_POOL_ABI);

      // Prepare calls
      for (const pool of pools) {
        if (pool.dexId === DexId.AERODROME || pool.dexId === DexId.BASESWAP) {
          // Aerodrome/BaseSwap: getReserves
          calls.push({
            target: pool.address,
            allowFailure: true,
            callData: poolInterfaceAero.encodeFunctionData("getReserves"),
          });
        } else if (pool.dexId === DexId.UNISWAP_V3) {
          // UniV3: slot0 & liquidity (requires 2 calls per pool)
          calls.push({
            target: pool.address,
            allowFailure: true,
            callData: poolInterfaceUni.encodeFunctionData("slot0"),
          });
          calls.push({
            target: pool.address,
            allowFailure: true,
            callData: poolInterfaceUni.encodeFunctionData("liquidity"),
          });
        }
      }

      // Execute single Multicall
      const results = await multicall.aggregate3(calls);
      
      let callIdx = 0;
      const updatedPools: PoolInfo[] = [];

      for (const pool of pools) {
        try {
          let reserve0 = 0n;
          let reserve1 = 0n;
          let price = 0;

          if (pool.dexId === DexId.AERODROME || pool.dexId === DexId.BASESWAP) {
            const res = results[callIdx++];
            if (!res.success) throw new Error("Aero call failed");
            
            const decoded = poolInterfaceAero.decodeFunctionResult("getReserves", res.returnData);
            reserve0 = decoded[0];
            reserve1 = decoded[1];
            
            price = await this.calculateAeroPrice(
              reserve0, reserve1, pool.token0, pool.token1, tokenA, tokenB, pool.stable
            );
          } else if (pool.dexId === DexId.UNISWAP_V3) {
            const resSlot0 = results[callIdx++];
            const resLiq = results[callIdx++];
            
            if (!resSlot0.success || !resLiq.success) throw new Error("UniV3 call failed");

            const slot0 = poolInterfaceUni.decodeFunctionResult("slot0", resSlot0.returnData);
            const liquidity = poolInterfaceUni.decodeFunctionResult("liquidity", resLiq.returnData)[0];
            
            reserve0 = BigInt(liquidity); // Proxy for V3
            reserve1 = BigInt(liquidity);
            
            price = await this.calculateUniV3Price(
              slot0[0], pool.token0, pool.token1, tokenA, tokenB
            );
          }

          updatedPools.push({ ...pool, reserve0, reserve1, price });
        } catch (err) {
          updatedPools.push({ ...pool, price: 0 }); // Mark as invalid
        }
      }

      return updatedPools;
    } catch (err: any) {
      log.error(`Multicall failed: ${err.message}. Falling back to single calls.`);
      // Fallback to sequential updates if multicall fails
      return Promise.all(pools.map(p => this.updatePoolData(p, tokenA, tokenB)));
    }
  }

  private async updatePoolData(pool: PoolInfo, tokenA: string, tokenB: string): Promise<PoolInfo> {
    try {
      if (pool.dexId === DexId.AERODROME) {
        const contract = new Contract(pool.address, AERODROME_POOL_ABI, this.provider);
        const reserves = await contract.getReserves();

        const price = await this.calculateAeroPrice(
          reserves.reserve0,
          reserves.reserve1,
          pool.token0,
          pool.token1,
          tokenA,
          tokenB,
          pool.stable || false
        );

        return { ...pool, reserve0: reserves.reserve0, reserve1: reserves.reserve1, price };
      } else {
        const contract = new Contract(pool.address, UNISWAP_V3_POOL_ABI, this.provider);
        const [slot0, liquidity] = await Promise.all([
          contract.slot0(),
          contract.liquidity(),
        ]);

        const price = await this.calculateUniV3Price(
          slot0.sqrtPriceX96,
          pool.token0,
          pool.token1,
          tokenA,
          tokenB
        );

        return { ...pool, reserve0: liquidity, reserve1: slot0.sqrtPriceX96, price };
      }
    } catch (err: any) {
      log.debug(`      ⚠️  Failed to update pool ${pool.address.slice(0, 8)}: ${err.message}`);
      return { ...pool, price: 0 };
    }
  }

  private async calculateAeroPrice(
    reserve0: bigint,
    reserve1: bigint,
    token0: string,
    token1: string,
    tokenA: string,
    tokenB: string,
    stable: boolean = false
  ): Promise<number> {
    if (reserve0 === 0n || reserve1 === 0n) return 0;

    const [dec0, dec1] = await Promise.all([
      this.getTokenDecimals(token0),
      this.getTokenDecimals(token1),
    ]);

    const r0 = Number(reserve0) / 10 ** dec0;
    const r1 = Number(reserve1) / 10 ** dec1;

    // [v3.7 Fix] Handle stable pools correctly.
    // In stable pools (x^3y + y^3x = k), the spot price is very close to 1.0 
    // unless reserves are extremely skewed. Simple r1/r0 fails here.
    if (stable) {
      const isStablePair =
        (tokenA.toLowerCase() === ADDRESSES.USDC.toLowerCase() && tokenB.toLowerCase() === ADDRESSES.USDbC.toLowerCase()) ||
        (tokenA.toLowerCase() === ADDRESSES.USDbC.toLowerCase() && tokenB.toLowerCase() === ADDRESSES.USDC.toLowerCase()) ||
        (tokenA.toLowerCase() === ADDRESSES.DAI.toLowerCase() && tokenB.toLowerCase() === ADDRESSES.USDC.toLowerCase());
      
      if (isStablePair) return 1.0;
    }

    // [v3.3 Fix] Standardize for volatile pools: If token0 is tokenA, then token1 is tokenB. Price = r1 / r0 (B/A).
    // If token0 is tokenB, then token1 is tokenA. Price = r0 / r1 (B/A).
    return token0.toLowerCase() === tokenA.toLowerCase() ? r1 / r0 : r0 / r1;
  }

  private async calculateUniV3Price(
    sqrtPriceX96: bigint,
    token0: string,
    token1: string,
    tokenA: string,
    tokenB: string
  ): Promise<number> {
    const [dec0, dec1] = await Promise.all([
      this.getTokenDecimals(token0),
      this.getTokenDecimals(token1),
    ]);

    const Q96 = 2n ** 96n;
    const priceX192 = sqrtPriceX96 * sqrtPriceX96;
    const rawPrice = Number(priceX192) / Number(Q96 * Q96);

    const price = rawPrice * 10 ** (dec0 - dec1);

    // [v3.3 Fix] Standardize: If token0 is tokenA, price is token1/token0 = B/A.
    // If token0 is tokenB, price is token1/token0 = A/B, so invert to B/A.
    return token0.toLowerCase() === tokenA.toLowerCase() ? price : 1 / price;
  }

  private async getTokenSymbol(address: string): Promise<string> {
    const addr = address.toLowerCase();
    const cached = this.knownTokens.get(addr);
    if (cached && cached.symbol) return cached.symbol;

    try {
      const token = new Contract(address, ERC20_ABI, this.provider);
      const symbol = await token.symbol();
      const decimals = await token.decimals();
      this.knownTokens.set(addr, { symbol, decimals: Number(decimals) });
      return symbol;
    } catch {
      return address.slice(0, 6);
    }
  }

  private async getTokenDecimals(address: string): Promise<number> {
    const addr = address.toLowerCase();
    const cached = this.knownTokens.get(addr);
    if (cached) return cached.decimals;

    try {
      const token = new Contract(address, ERC20_ABI, this.provider);
      const decimals = await token.decimals();
      const decNum = Number(decimals);
      this.knownTokens.set(addr, { symbol: "", decimals: decNum });
      return decNum;
    } catch {
      return 18;
    }
  }

  /**
   * [v3.4] Robust pricing helper for simulation results.
   * Handles WETH/USDC/DAI as base assets for human-readable USD profit tracking.
   */
  private async getBasePrice(token: string, pool: PoolInfo): Promise<number> {
    const addr = token.toLowerCase();

    // Direct matches
    if (addr === ADDRESSES.WETH.toLowerCase()) {
      const { getEthPriceUSD } = await import("../utils/prices");
      return await getEthPriceUSD();
    }
    if (addr === ADDRESSES.USDC.toLowerCase() || addr === ADDRESSES.USDbC.toLowerCase() || addr === ADDRESSES.DAI.toLowerCase()) {
      return 1.0;
    }

    // Cross-rate via TokenB if possible
    const tokenB = pool.tokenB.toLowerCase();
    if (tokenB === ADDRESSES.WETH.toLowerCase()) {
      const { getEthPriceUSD } = await import("../utils/prices");
      const ethPrice = await getEthPriceUSD();
      return pool.price * ethPrice; // (WETH/AERO) * (USD/WETH) = USD/AERO
    }
    if (tokenB === ADDRESSES.USDC.toLowerCase() || tokenB === ADDRESSES.USDbC.toLowerCase()) {
      return pool.price; // (USDC/AERO) * 1.0 = USD/AERO
    }

    return 1.0; // Fallback
  }
}
