/**
 * ════════════════════════════════════════════════════════════════
 *  IronShield Profit Calculator v3.1 — Cross-Currency Safe
 *
 *  CRITICAL FIXES:
 *    [FIX #1] Currency/Decimal Mismatch Resolution
 *      PROBLEM: Previous version subtracted gas costs (18 decimals, wei)
 *      directly from token profits (e.g., USDC with 6 decimals).
 *      Example: 5_000_000n (5 USDC) - 100_000_000_000_000n (0.0001 ETH gas)
 *      = -99_999_995_000_000n → massive negative → always "unprofitable"
 *
 *      FIX: Convert BOTH token profit and gas cost to absolute USD FIRST,
 *      then compute netProfitUSD = contractProfitUSD - totalGasCostUSD.
 *      All profitability decisions are made exclusively in USD space.
 *      No cross-decimal arithmetic is ever performed.
 *
 *    [UPGRADE #3] OP Stack L1 Data Fee Integration (preserved)
 *    [UPGRADE #4] EOA Wallet Wear Protection (preserved, now in USD)
 * ════════════════════════════════════════════════════════════════
 */
import { ethers } from "ethers";
import { createModuleLogger } from "../utils/logger";
import { getEthPriceUSD } from "../utils/prices";
import { EXECUTION } from "../config/config";

const log = createModuleLogger("PROFIT");

// ── OP Stack Gas Price Oracle ────────────────────────────────
const OP_GAS_ORACLE_ADDRESS = "0x420000000000000000000000000000000000000F";
const OP_GAS_ORACLE_ABI = [
  "function getL1Fee(bytes memory _data) external view returns (uint256)",
  "function l1BaseFee() external view returns (uint256)",
  "function baseFeeScalar() external view returns (uint32)",
  "function blobBaseFeeScalar() external view returns (uint32)",
  "function blobBaseFee() external view returns (uint256)",
] as const;

// ── Types ────────────────────────────────────────────────────

export interface ProfitResult {
  /** Profit remaining in the contract (in asset's native decimals) */
  contractProfitRaw: bigint;
  /** Contract profit converted to USD (using assetPriceUSD) */
  contractProfitUSD: number;
  grossProfitRaw: bigint;
  loanPremiumRaw: bigint;
  /** L2 execution gas cost (in wei, 18 decimals) */
  l2GasCostWei: bigint;
  /** L1 data posting fee (in wei) */
  l1DataFeeWei: bigint;
  /** Total gas cost = L2 + L1 (in wei) */
  totalGasCostWei: bigint;
  /** Total gas cost converted to USD (using ETH price) */
  totalGasCostUSD: number;
  /**
   * [FIX #1] TRUE net profit — computed ENTIRELY in USD space:
   *   netProfitUSD = contractProfitUSD - totalGasCostUSD
   *
   * This is the correct cross-currency calculation. We never
   * subtract wei (18 dec) from token amounts (6/8/18 dec).
   */
  netProfitUSD: number;
  isProfitable: boolean;
  meetsThreshold: boolean;
}

export class ProfitCalculator {
  private readonly AAVE_PREMIUM_BPS = 5n; // 0.05%
  private provider: ethers.JsonRpcProvider;
  private gasOracle: ethers.Contract;

  constructor(provider: ethers.JsonRpcProvider) {
    this.provider = provider;
    this.gasOracle = new ethers.Contract(
      OP_GAS_ORACLE_ADDRESS,
      OP_GAS_ORACLE_ABI,
      provider
    );
  }

  /** Estimate the L1 Data Fee for transaction calldata */
  async estimateL1DataFee(txCalldata: string): Promise<bigint> {
    try {
      const l1Fee: bigint = await this.gasOracle.getL1Fee(txCalldata);
      return l1Fee;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`⚠️  L1 fee estimation failed (using 0): ${msg}`);
      return 0n;
    }
  }

  /**
   * Calculate net profit with full cross-currency safety.
   *
   * [FIX #1] Key change: This function now requires `assetDecimals` and
   * `assetPriceUSD` so it can convert token-denominated profit into USD
   * before comparing with gas costs (which are in ETH/wei).
   *
   * @param flashLoanAmount  Amount borrowed (in asset's native decimals)
   * @param outputAmount     Amount after swaps (in asset's native decimals)
   * @param l2GasUsed        L2 gas units consumed
   * @param l2GasPriceWei    Current L2 gas price in wei
   * @param assetDecimals    Decimals of the asset (e.g., 6 for USDC, 18 for WETH)
   * @param assetPriceUSD    Current USD price of 1 unit of the asset
   * @param txCalldata       Raw calldata for L1 fee estimation
   */
  async calculateNetProfit(
    flashLoanAmount: bigint,
    outputAmount: bigint,
    l2GasUsed: bigint,
    l2GasPriceWei: bigint,
    assetDecimals: number,
    assetPriceUSD: number,
    txCalldata: string = "0x",
    cachedL1Fee?: bigint,
    cachedEthPrice?: number
  ): Promise<ProfitResult> {
    // ── Step 1: Contract-side profit (in asset's native decimals) ──
    const loanPremium = (flashLoanAmount * this.AAVE_PREMIUM_BPS) / 10000n;
    const grossProfit = outputAmount - flashLoanAmount - loanPremium;
    const contractProfit = grossProfit;

    // ── Step 2: Convert contract profit to USD ──────────────────
    // [FIX #1] Convert from asset-native decimals to human units, then to USD.
    // e.g., 5_000_000 USDC (6 dec) → 5.0 USDC → 5.0 * $1.00 = $5.00
    // e.g., 1_500_000_000_000_000 WETH (18 dec) → 0.0015 WETH → 0.0015 * $3500 = $5.25
    const contractProfitHuman = Number(
      ethers.formatUnits(contractProfit, assetDecimals)
    );
    const contractProfitUSD = contractProfitHuman * assetPriceUSD;

    // ── Step 3: L2 execution gas cost (wei → ETH → USD) ────────
    const gasBufferMultiplier = BigInt(
      Math.round(EXECUTION.GAS_BUFFER_MULTIPLIER * 100)
    );
    const l2GasCost = (l2GasUsed * l2GasPriceWei * gasBufferMultiplier) / 100n;

    // ── Step 4: L1 Data Fee (wei) ──────────────────────────────
    const l1DataFee = cachedL1Fee ?? await this.estimateL1DataFee(txCalldata);

    // ── Step 5: Total gas cost → USD ───────────────────────────
    const totalGasCostWei = l2GasCost + l1DataFee;
    const ethPrice = cachedEthPrice ?? await getEthPriceUSD();
    const totalGasCostUSD =
      Number(ethers.formatEther(totalGasCostWei)) * ethPrice;

    // ── Step 6: [FIX #1] Net profit — PURE USD arithmetic ──────
    // This is the ONLY correct way to compare cross-currency values.
    // contractProfit is in USDC/WETH/DAI, gasCost is in ETH.
    // Both are now in USD, so subtraction is dimensionally valid.
    const netProfitUSD = contractProfitUSD - totalGasCostUSD;

    const isProfitable = netProfitUSD > 0;
    const meetsThreshold = netProfitUSD >= EXECUTION.MIN_PROFIT_USD;

    const result: ProfitResult = {
      contractProfitRaw: contractProfit,
      contractProfitUSD,
      grossProfitRaw: grossProfit,
      loanPremiumRaw: loanPremium,
      l2GasCostWei: l2GasCost,
      l1DataFeeWei: l1DataFee,
      totalGasCostWei,
      totalGasCostUSD,
      netProfitUSD,
      isProfitable,
      meetsThreshold,
    };

    // ── MEV-grade logging ───────────────────────────────────
    if (meetsThreshold) {
      log.info(
        `💰 PROFITABLE | Net: $${netProfitUSD.toFixed(4)} | ` +
          `Contract: $${contractProfitUSD.toFixed(4)} (${contractProfitHuman.toFixed(6)} asset) | ` +
          `Gas: $${totalGasCostUSD.toFixed(4)} (L2: $${(Number(ethers.formatEther(l2GasCost)) * ethPrice).toFixed(4)}, ` +
          `L1: $${(Number(ethers.formatEther(l1DataFee)) * ethPrice).toFixed(4)})`
      );
    } else if (isProfitable) {
      log.debug(
        `Near-miss: $${netProfitUSD.toFixed(4)} (threshold: $${EXECUTION.MIN_PROFIT_USD})`
      );
    } else {
      log.debug(
        `Unprofitable: $${netProfitUSD.toFixed(4)} | ` +
          `Profit $${contractProfitUSD.toFixed(4)} < Gas $${totalGasCostUSD.toFixed(4)}`
      );
    }

    return result;
  }

  /**
   * Quick viability check — fast-path filter before full simulation.
   * Operates entirely in USD space (no decimal mixing).
   */
  async isSpreadViable(
    spreadPct: number,
    loanAmountHuman: number,
    assetPriceUSD: number,
    estimatedGas: bigint = 300_000n
  ): Promise<boolean> {
    const ethPrice = await getEthPriceUSD();
    const loanValueUSD = loanAmountHuman * assetPriceUSD;

    const grossProfitUSD = loanValueUSD * (spreadPct / 100);
    const loanFeeUSD = loanValueUSD * 0.0005;

    // L2 gas (assume 0.1 gwei base fee on Base)
    const l2GasCostETH = Number(ethers.formatEther(estimatedGas * 100_000_000n));
    const l2GasCostUSD = l2GasCostETH * ethPrice * EXECUTION.GAS_BUFFER_MULTIPLIER;
    const l1FeeEstimateUSD = 0.05; // Conservative L1 estimate

    const netProfitUSD =
      grossProfitUSD - loanFeeUSD - l2GasCostUSD - l1FeeEstimateUSD;
    return netProfitUSD >= EXECUTION.MIN_PROFIT_USD;
  }

  /**
   * Binary search for optimal loan amount maximizing net profit.
   * Now requires asset price and decimals for correct USD conversion.
   */
  async calculateOptimalLoanAmount(
    spreadPct: number,
    maxLiquidity: bigint,
    gasPriceWei: bigint,
    assetDecimals: number,
    assetPriceUSD: number,
    txCalldata: string = "0x"
  ): Promise<bigint> {
    // [v3.3 Fix] Pre-fetch L1 fee and ETH price outside loop to prevent RPC Bomb
    const [cachedL1Fee, cachedEthPrice] = await Promise.all([
      this.estimateL1DataFee(txCalldata),
      getEthPriceUSD()
    ]);

    let low = ethers.parseEther("0.1");
    let high = maxLiquidity;
    let optimal = low;

    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2n;
      const expectedOutput =
        mid + (mid * BigInt(Math.round(spreadPct * 100))) / 10000n;

      const profitResult = await this.calculateNetProfit(
        mid,
        expectedOutput,
        300_000n,
        gasPriceWei,
        assetDecimals,
        assetPriceUSD,
        txCalldata,
        cachedL1Fee,
        cachedEthPrice
      );

      if (profitResult.meetsThreshold) {
        optimal = mid;
        low = mid + 1n;
      } else {
        high = mid - 1n;
      }
    }

    return optimal;
  }
}
