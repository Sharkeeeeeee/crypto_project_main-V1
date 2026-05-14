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
  private sushiFactory: Contract;
  private swapBasedFactory: Contract;
  private alienBaseFactory: Contract;
  private pancakeFactory: Contract;
  private knownTokens: Map<string, { symbol: string; decimals: number }> = new Map();
  private discoveredPools: Map<string, PoolInfo> = new Map();

  // 1. 新增輪詢狀態
  private rotationIndex = 0;
  private readonly ROTATION_SIZE = 20; // [v4.9] Expanded rotation to 20 assets for massive coverage
  private poolAddressCache: Map<string, PoolInfo[]> = new Map();
  private cycleCount: number = 0;
  private lastBlock: number = 0;

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
    this.sushiFactory = new Contract(
      ADDRESSES.SUSHI_FACTORY,
      AERODROME_FACTORY_ABI, // Sushi uses UniV2 style factory
      provider
    );
    this.swapBasedFactory = new Contract(
      ADDRESSES.SWAPBASED_FACTORY,
      AERODROME_FACTORY_ABI,
      provider
    );
    this.alienBaseFactory = new Contract(
      ADDRESSES.ALIENBASE_FACTORY,
      AERODROME_FACTORY_ABI,
      provider
    );
    this.pancakeFactory = new Contract(
      ADDRESSES.PANCAKESWAP_V3_FACTORY,
      UNISWAP_V3_FACTORY_ABI,
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
    this.knownTokens.set("0xBC452fdC8E606622643021BbDE1d20d0567501bb".toLowerCase(), { symbol: "BENJI", decimals: 18 });
    this.knownTokens.set("0xAc02111867184f988960Ee04b281Ba29f0860d5d".toLowerCase(), { symbol: "MIGGLES", decimals: 18 });
    this.knownTokens.set("0xf0809277A85521C5f778736aF08c7A512e9603f0".toLowerCase(), { symbol: "CHOMPY", decimals: 18 });
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
      this.cycleCount++;
      const blockNumber = await this.provider.getBlockNumber();
      this.lastBlock = blockNumber;
      const tokenPairs = this.generateTokenPairs();
      
      log.info(`🔍 Scan Cycle #${this.cycleCount} | Block: ${blockNumber} | Scanning: ${tokenPairs.length} pairs`);

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
          if (pools.length === 0) continue;
          
          const labelA = tokenA.slice(-4);
          const labelB = tokenB.slice(-4);
          
          // [v5.6] Universal Trace: See what's actually coming out of the DEX scanners
          if (pools.length >= 2 || labelA === "2913" || labelB === "2913") {
             console.log(` 🔍 [SCAN_TRACE] ${labelA}/${labelB} | Pools: ${pools.length} | Prices: ${pools.map(p => `${DexId[p.dexId]}:${p.price.toFixed(4)}`).join(", ")}`);
          }

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

          // [v5.0] Exhaustive search: find the best pair based on NET profit
          let bestNetSpread = -100;
          let bestPair: { buy: PoolInfo, sell: PoolInfo } | null = null;

          for (const p1 of pools) {
            for (const p2 of pools) {
              if (p1.address === p2.address) continue;
              
              // [v6.4] Correct Arbitrage Logic:
              // We start with TokenA (WETH). 
              // 1. Swap A -> B in p1: We get p1.price units of B.
              // 2. Swap B -> A in p2: We get (p1.price / p2.price) units of A.
              // Profit exists if p1.price > p2.price (Buy B where price is HIGH, Sell B where price is LOW)
              
              const grossSpread = ((p1.price - p2.price) / p2.price) * 100;
              
              const getFee = (p: PoolInfo) => {
                if (p.dexId === DexId.UNISWAP_V3 || p.dexId === DexId.PANCAKESWAP_V3) return p.fee / 1000000; // UniV3 fee is in ppm
                if (p.dexId === DexId.AERODROME) return p.stable ? 0.0001 : 0.003; 
                return 0.003; // Default 0.3%
              };

              const totalFees = getFee(p1) + getFee(p2);
              const currentNetSpread = grossSpread - (totalFees * 100);

              if (currentNetSpread > bestNetSpread) {
                bestNetSpread = currentNetSpread;
                bestPair = { buy: p1, sell: p2 };
              }
            }
          }

          if (bestPair && bestNetSpread > -1.0) { 
             const isOpportunity = bestNetSpread >= SCANNER.MIN_SPREAD_PCT;
             const grossSpread = ((bestPair.buy.price - bestPair.sell.price) / bestPair.sell.price) * 100;
             
             if (isOpportunity) {
                const symbolA = await this.getTokenSymbol(tokenA);
                const symbolB = await this.getTokenSymbol(tokenB);
                discrepancies.push({
                  tokenA, tokenB, symbolA, symbolB, pools,
                  maxSpread: bestNetSpread, 
                  bestBuyPool: bestPair.buy, 
                  bestSellPool: bestPair.sell,
                });
                console.log(`🎯 [OPPORTUNITY] ${symbolA}/${symbolB} | Net: ${bestNetSpread.toFixed(3)}% | ${DexId[bestPair.buy.dexId]}->${DexId[bestPair.sell.dexId]}`);
             } else if (grossSpread > 0.05) {
                // Use slice for fast, non-blocking address display
                const labelA = tokenA.slice(-4);
                const labelB = tokenB.slice(-4);
                
                // [v5.5 Special Diagnostic]
                if (labelA === "2913" && labelB === "b6CA") {
                   console.log(` 🕵️ STABLE_TRACE | Net: ${bestNetSpread.toFixed(4)}% | Pools: ${pools.length} | Best: ${DexId[bestPair.buy.dexId]} (${bestPair.buy.price.toFixed(6)}) -> ${DexId[bestPair.sell.dexId]} (${bestPair.sell.price.toFixed(6)})`);
                }

                console.log(` [DEBUG] ${labelA}/${labelB} | Net: ${bestNetSpread.toFixed(3)}% (Gross: ${grossSpread.toFixed(3)}%) | ${DexId[bestPair.buy.dexId]}->${DexId[bestPair.sell.dexId]} | Pools: ${pools.length}`);
             }
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

      log.info(`✅ Scan Cycle #${this.cycleCount || 0} | Block: ${this.lastBlock || "unknown"} | Found: ${discrepancies.length} opportunities. Top: ${topLabels}`);
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
      let reserveIn: bigint;
      
      if (firstPool.dexId === DexId.UNISWAP_V3 || firstPool.dexId === DexId.PANCAKESWAP_V3) {
        // [v5.8] V3 Liquidity Proxy: liquidity is NOT reserve.
        // For V3, we use a conservative fixed amount if liquidity exists
        reserveIn = firstPool.reserve0 > 1000000000n ? ethers.parseUnits("1000", 18) : 0n;
      } else {
        reserveIn = firstPool.token0.toLowerCase() === disc.tokenA.toLowerCase()
          ? firstPool.reserve0
          : firstPool.reserve1;
      }

      // [v5.3] Dynamic Loan Sizing: Calculate based on liquidity depth
      // Deep pools (> 1000 ETH reserve) can handle 2.0 ETH
      // Shallow pools should only handle ~0.5% of reserves to avoid slippage
      const reserveThreshold = ethers.parseUnits("500", 18);
      let loanAmount;
      
      if (reserveIn > reserveThreshold) {
        loanAmount = EXECUTION.DEFAULT_LOAN_AMOUNT; // Up to 2.0 ETH
      } else {
        // Shallow pool: restrict to 0.5% to protect spread from slippage
        loanAmount = (reserveIn * 5n) / 1000n;
      }

      if (loanAmount === 0n) loanAmount = ethers.parseUnits("0.01", 18);

      // [v6.3] Calculate estimated profit for public RPC fallbacks
      const spreadMultiplier = BigInt(Math.round(disc.maxSpread * 100)); // 1.5% -> 150
      const estimatedProfit = (loanAmount * spreadMultiplier) / 10000n;
      log.debug(`      💡 Est. Profit: ${ethers.formatEther(estimatedProfit)} asset (Spread: ${disc.maxSpread.toFixed(3)}%)`);

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
        estimatedProfit: estimatedProfit,
        estimatedGas: 350000n, // Default estimate
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
  private async getAerodromePools(tokenA: string, tokenB: string): Promise<PoolInfo[]> {
    const pools: PoolInfo[] = [];
    const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
    const isStableA = tokenA.toLowerCase() === ADDRESSES.USDC.toLowerCase() || tokenA.toLowerCase() === ADDRESSES.USDbC.toLowerCase() || tokenA.toLowerCase() === ADDRESSES.DAI.toLowerCase();
    const isStableB = tokenB.toLowerCase() === ADDRESSES.USDC.toLowerCase() || tokenB.toLowerCase() === ADDRESSES.USDbC.toLowerCase() || tokenB.toLowerCase() === ADDRESSES.DAI.toLowerCase();
    const canBeStable = isStableA && isStableB;

    for (const stable of [false, true]) {
      if (stable && !canBeStable) continue; // Only scan stable pools for actual stablecoins
      try {
        let poolAddr = await this.aeroFactory.getPool(t0, t1, stable);
        if (poolAddr === ethers.ZeroAddress) {
           poolAddr = await this.aeroFactory.getPool(t1, t0, stable);
        }
        if (poolAddr === ethers.ZeroAddress) continue;

        pools.push({
          address: poolAddr, dexId: DexId.AERODROME, token0: t0, token1: t1, tokenA, tokenB,
          reserve0: 0n, reserve1: 0n, fee: stable ? 1 : 30, stable, price: 0, liquidityUSD: 0,
        });
      } catch (e) { continue; }
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

        pools.push({
          address: poolAddr,
          dexId: DexId.UNISWAP_V3,
          token0: t0,
          token1: t1,
          tokenA,
          tokenB,
          reserve0: 0n,
          reserve1: 0n,
          fee,
          price: 0,
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
    const aeroPools = await this.getAerodromePools(tokenA, tokenB);
    const uniPools = await this.getUniV3StylePools(tokenA, tokenB, this.uniV3Factory, DexId.UNISWAP_V3);
    const pancakePools = await this.getUniV3StylePools(tokenA, tokenB, this.pancakeFactory, DexId.PANCAKESWAP_V3);
    
    await sleep(SCANNER.POOL_SCAN_JITTER_MS);
    const baseSwapPools = await this.getBaseSwapPools(tokenA, tokenB);
    const sushiPools = await this.getGenericUniV2Pools(tokenA, tokenB, this.sushiFactory, DexId.SUSHISWAP, 30);
    const swapBasedPools = await this.getGenericUniV2Pools(tokenA, tokenB, this.swapBasedFactory, DexId.SWAPBASED, 25);
    const alienBasePools = await this.getGenericUniV2Pools(tokenA, tokenB, this.alienBaseFactory, DexId.ALIENBASE, 16);

    const allPools = [
      ...uniPools,
      ...aeroPools,
      ...baseSwapPools,
      ...sushiPools,
      ...swapBasedPools,
      ...alienBasePools,
      ...pancakePools,
    ].filter(p => [DexId.AERODROME, DexId.UNISWAP_V3, DexId.BASESWAP].includes(p.dexId));

    const updatedPools = await this.updatePoolsBatch(allPools, tokenA, tokenB);

    // [v6.1] Decimal-Aware Liquidity Guard
    const decA = await this.getTokenDecimals(tokenA);
    const decB = await this.getTokenDecimals(tokenB);
    
    // We want at least ~$10,000 of liquidity or 5 ETH equivalent
    const minReserveA = 5n * 10n**BigInt(decA); 
    const minReserveB = 5n * 10n**BigInt(decB);

    const filteredPools = updatedPools.filter(p => {
       let passed = false;
       if (p.dexId === DexId.UNISWAP_V3 || p.dexId === DexId.PANCAKESWAP_V3) {
          passed = p.reserve0 > 1000000000000000000n; 
       } else {
          passed = p.reserve0 > minReserveA || p.reserve1 > minReserveB;
       }
       return passed;
    });

    if (updatedPools.length > filteredPools.length) {
       log.debug(`      ⚠️ Filtered ${updatedPools.length - filteredPools.length} shallow pools for this pair.`);
    }

    if (filteredPools.length === 0) {
      const sA = this.knownTokens.get(tokenA)?.symbol || tokenA.slice(0, 6);
      const sB = this.knownTokens.get(tokenB)?.symbol || tokenB.slice(0, 6);
      log.warn(`No deep pools found for pair: ${sA}-${sB}`);
    }

    return filteredPools;
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

      return [{
        address: poolAddr,
        dexId: DexId.BASESWAP,
        token0: t0,
        token1: t1,
        tokenA,
        tokenB,
        reserve0: 0n,
        reserve1: 0n,
        fee: 25, // 0.25% fee
        price: 0,
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
    const rawPairs: [string, string][] = [];

    // 【固定掃描】核心幣對：每一輪必掃
    rawPairs.push([ADDRESSES.WETH, ADDRESSES.USDC]);
    rawPairs.push([ADDRESSES.USDC, ADDRESSES.USDbC]);
    rawPairs.push([ADDRESSES.WETH, ADDRESSES.AERODROME_FACTORY]);
    rawPairs.push([ADDRESSES.WETH, "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"]); // DEGEN
    rawPairs.push([ADDRESSES.WETH, "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b"]); // VIRTUAL

    // 【輪詢掃描】長尾代幣
    const allTokens = [
      ...ADDRESSES.EXTENDED_WHITELIST,
      "0xBC452fdC8E606622643021BbDE1d20d0567501bb", // BENJI
      "0xAc02111867184f988960Ee04b281Ba29f0860d5d", // MIGGLES
      "0xf0809277A85521C5f778736aF08c7A512e9603f0", // CHOMPY
    ];
    
    if (allTokens.length > 0) {
      const scanCount = Math.min(this.ROTATION_SIZE, allTokens.length);
      for (let i = 0; i < scanCount; i++) {
        const targetToken = allTokens[(this.rotationIndex + i) % allTokens.length];
        rawPairs.push([ADDRESSES.WETH, targetToken]);
      }
      this.rotationIndex = (this.rotationIndex + scanCount) % allTokens.length;
    }

    // [v5.2] De-duplicate pairs using a Set
    const uniquePairs: [string, string][] = [];
    const seen = new Set<string>();

    for (const [a, b] of rawPairs) {
      const key = [a.toLowerCase(), b.toLowerCase()].sort().join("-");
      if (!seen.has(key) && a.toLowerCase() !== b.toLowerCase()) {
        seen.add(key);
        uniquePairs.push([a, b]);
      }
    }

    return uniquePairs;
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
      const poolInterfaceV3 = new ethers.Interface(UNISWAP_V3_POOL_ABI);

      // Prepare calls
      for (const pool of pools) {
        if (pool.dexId === DexId.UNISWAP_V3 || pool.dexId === DexId.PANCAKESWAP_V3) {
          // V3 Style: slot0 & liquidity
          calls.push({
            target: pool.address,
            allowFailure: true,
            callData: poolInterfaceV3.encodeFunctionData("slot0"),
          });
          calls.push({
            target: pool.address,
            allowFailure: true,
            callData: poolInterfaceV3.encodeFunctionData("liquidity"),
          });
        } else {
          // V2 Style: getReserves
          calls.push({
            target: pool.address,
            allowFailure: true,
            callData: poolInterfaceAero.encodeFunctionData("getReserves"),
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

          if (pool.dexId === DexId.UNISWAP_V3 || pool.dexId === DexId.PANCAKESWAP_V3) {
            const resSlot0 = results[callIdx++];
            const resLiq = results[callIdx++];
            
            if (!resSlot0.success || !resLiq.success) throw new Error("V3 call failed");
            
            const decodedSlot0 = poolInterfaceV3.decodeFunctionResult("slot0", resSlot0.returnData);
            const decodedLiq = poolInterfaceV3.decodeFunctionResult("liquidity", resLiq.returnData);
            
            reserve0 = decodedLiq[0]; // Liquidity
            reserve1 = decodedSlot0[0]; // sqrtPriceX96
            
            price = await this.calculateUniV3Price(
              reserve1,
              pool.token0,
              pool.token1,
              tokenA,
              tokenB
            );
          } else {
            const res = results[callIdx++];
            if (!res.success) throw new Error("V2 call failed");
            
            const decoded = poolInterfaceAero.decodeFunctionResult("getReserves", res.returnData);
            reserve0 = decoded[0];
            reserve1 = decoded[1];
            
            price = await this.calculateAeroPrice(
              reserve0, reserve1, pool.token0, pool.token1, tokenA, tokenB, pool.stable || false
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
      
      if (isStablePair) {
        // [v5.4] Improved Stable Price: 
        // In stable pools, price is heavily buffered towards 1.0.
        // We use a 0.99 + 0.01*(r1/r0) weight to simulate the curve's flatness more accurately.
        const ratio = r1 / r0;
        return 0.99 + (0.01 * ratio);
      }
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

  private async getUniV3StylePools(
    tokenA: string,
    tokenB: string,
    factory: Contract,
    dexId: DexId
  ): Promise<PoolInfo[]> {
    const pools: PoolInfo[] = [];
    const fees = [UniV3Fee.LOWEST, UniV3Fee.LOW, UniV3Fee.MEDIUM, UniV3Fee.HIGH];
    const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

    for (const fee of fees) {
      try {
        const poolAddr = await factory.getPool(t0, t1, fee);
        if (poolAddr === ethers.ZeroAddress) continue;

        pools.push({
          address: poolAddr, dexId, token0: t0, token1: t1, tokenA, tokenB,
          reserve0: 0n, reserve1: 0n, fee, price: 0, liquidityUSD: 0,
        });
      } catch (e) { continue; }
    }
    return pools;
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
    } catch { return address.slice(0, 6); }
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
    } catch { return 18; }
  }

  private async getBasePrice(token: string, pool: PoolInfo): Promise<number> {
    const addr = token.toLowerCase();
    if (addr === ADDRESSES.WETH.toLowerCase()) {
      const { getEthPriceUSD } = await import("../utils/prices");
      return await getEthPriceUSD();
    }
    if (addr === ADDRESSES.USDC.toLowerCase() || addr === ADDRESSES.USDbC.toLowerCase() || addr === ADDRESSES.DAI.toLowerCase()) {
      return 1.0;
    }
    const tokenB = pool.tokenB.toLowerCase();
    if (tokenB === ADDRESSES.WETH.toLowerCase()) {
      const { getEthPriceUSD } = await import("../utils/prices");
      const ethPrice = await getEthPriceUSD();
      return pool.price * ethPrice;
    }
    if (tokenB === ADDRESSES.USDC.toLowerCase() || tokenB === ADDRESSES.USDbC.toLowerCase()) {
      return pool.price;
    }
    return 1.0;
  }

  private async getGenericUniV2Pools(
    tokenA: string, 
    tokenB: string, 
    factory: Contract, 
    dexId: DexId, 
    fee: number
  ): Promise<PoolInfo[]> {
    try {
      const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
      const poolAddr = await factory.getPair(t0, t1);
      if (poolAddr === ethers.ZeroAddress) return [];

      return [{
        address: poolAddr, dexId, token0: t0, token1: t1, tokenA, tokenB,
        reserve0: 0n, reserve1: 0n, fee, stable: false, price: 0, liquidityUSD: 0
      }];
    } catch (e) { return []; }
  }
}
