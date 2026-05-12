/**
 * IronShield Path Optimizer v3.1
 * Multi-path concurrent simulation with L1+L2 USD-safe profit validation
 *
 * [v3.1 FIXES]
 *   - Updated initiateArbitrage ABI: now includes minProfit parameter
 *   - calculateNetProfit now takes assetDecimals + assetPriceUSD for
 *     correct cross-currency profit evaluation
 */
import { ethers, Contract, AbiCoder } from "ethers";
import { createModuleLogger } from "../utils/logger";
import { getEthPriceUSD } from "../utils/prices";
import { ForkEngine } from "./forkEngine";
import { ProfitCalculator } from "./profitCalculator";
import {
  ArbitragePath,
  SimulationResult,
  SwapStep,
  EXECUTION,
  SCANNER,
  ADDRESSES,
} from "../config/config";

const log = createModuleLogger("OPTIMIZER");

// [FIX #2] Updated ABI: includes minProfit parameter
const EXECUTOR_ABI = [
  "function initiateArbitrage(address asset, uint256 amount, uint256 minProfit, uint256 deadline, bytes swapData) external",
];

// Asset metadata for cross-currency profit calculation
const ASSET_METADATA: Record<string, { decimals: number; symbol: string }> = {
  [ADDRESSES.WETH.toLowerCase()]: { decimals: 18, symbol: "WETH" },
  [ADDRESSES.USDC.toLowerCase()]: { decimals: 6, symbol: "USDC" },
  [ADDRESSES.USDbC.toLowerCase()]: { decimals: 6, symbol: "USDbC" },
  [ADDRESSES.DAI.toLowerCase()]: { decimals: 18, symbol: "DAI" },
};

function getAssetDecimals(address: string): number {
  return ASSET_METADATA[address.toLowerCase()]?.decimals ?? 18;
}

export class PathOptimizer {
  private forkEngine: ForkEngine;
  private profitCalc: ProfitCalculator;
  private executorAddress: string;

  constructor(
    forkEngine: ForkEngine,
    profitCalc: ProfitCalculator,
    executorAddress: string
  ) {
    this.forkEngine = forkEngine;
    this.profitCalc = profitCalc;
    this.executorAddress = executorAddress;
  }

  async simulatePaths(paths: ArbitragePath[]): Promise<SimulationResult[]> {
    const results: SimulationResult[] = [];
    const concurrency = Math.min(paths.length, SCANNER.MAX_CONCURRENT_SIMULATIONS);

    log.debug(`⚡ Simulating ${paths.length} paths (concurrency: ${concurrency})`);

    for (let i = 0; i < paths.length; i += concurrency) {
      const batch = paths.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((path) => this.simulateSinglePath(path))
      );
      results.push(...batchResults);
    }

    results.sort((a, b) => b.profitUSD - a.profitUSD);

    const profitable = results.filter(
      (r) => r.success && r.profitUSD >= EXECUTION.MIN_PROFIT_USD
    );
    log.info(
      `✅ Simulation complete: ${profitable.length}/${results.length} profitable paths`
    );

    return results;
  }

  private async simulateSinglePath(path: ArbitragePath): Promise<SimulationResult> {
    const startTime = Date.now();
    const provider = this.forkEngine.getProvider();

    try {
      const loanAmount = path.loanAmount || EXECUTION.DEFAULT_LOAN_AMOUNT;
      const encodedSteps = this.encodeSwapSteps(path.steps, loanAmount);

      const deadline = Math.floor(Date.now() / 1000) + 300;
      const minProfit = 0n; // Simulation uses 0; real execution sets proper value
      
      const assetAddress = path.steps[0].tokenIn;
      const assetDecimals = getAssetDecimals(assetAddress);

      const executor = new Contract(this.executorAddress, EXECUTOR_ABI, provider);
      const callData = executor.interface.encodeFunctionData("initiateArbitrage", [
        assetAddress,
        loanAmount,
        minProfit,
        deadline,
        encodedSteps,
      ]);

      const signerAddr = await provider
        .getSigner()
        .then((s) => s.address)
        .catch(() => ethers.ZeroAddress);

      const simResult = await this.forkEngine.simulateAndGetBalanceChange(
        this.executorAddress,
        callData,
        signerAddr,
        assetAddress
      );

      if (!simResult.success) {
        return {
          path,
          success: false,
          outputAmount: 0n,
          gasUsed: 0n,
          netProfit: 0n,
          profitUSD: 0,
          errorMessage: simResult.error,
          executionTimeMs: Date.now() - startTime,
        };
      }

      // [FIX #1] Calculate profit with correct asset decimals and price
      const gasPrice = await this.forkEngine.getGasPrice();
      const ethPrice = await getEthPriceUSD();
      
      const assetPriceUSD = path.assetPriceUSD || (assetAddress.toLowerCase() === ADDRESSES.WETH.toLowerCase() ? ethPrice : 1.0);

      // [v3.6 Fallback] If outputAmount is 1n, it means we are on a public RPC
      // and couldn't read the state change. We trust the scanner's estimate
      // if the simulation (eth_call) succeeded.
      const actualOutput = simResult.outputAmount === 1n 
        ? loanAmount + path.estimatedProfit 
        : simResult.outputAmount;

      const profitInfo = await this.profitCalc.calculateNetProfit(
        loanAmount,
        actualOutput,
        simResult.gasUsed,
        gasPrice,
        assetDecimals,
        assetPriceUSD,
        callData
      );

      // [v4.6] Diagnostic Logging
      if (profitInfo.netProfitUSD < EXECUTION.MIN_PROFIT_USD) {
        log.debug(
          `📉 Path Rejected: ${path.id} | ` +
          `Gross: $${profitInfo.contractProfitUSD.toFixed(3)} | ` +
          `Gas: $${profitInfo.totalGasCostUSD.toFixed(3)} | ` +
          `Net: $${profitInfo.netProfitUSD.toFixed(3)}`
        );
      } else {
        log.info(
          `💰 Profitable Path: ${path.id} | ` +
          `Net Profit: $${profitInfo.netProfitUSD.toFixed(2)}`
        );
      }

      return {
        path,
        success: profitInfo.isProfitable,
        outputAmount: simResult.outputAmount,
        gasUsed: simResult.gasUsed,
        netProfit: profitInfo.contractProfitRaw,
        profitUSD: profitInfo.netProfitUSD,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        path,
        success: false,
        outputAmount: 0n,
        gasUsed: 0n,
        netProfit: 0n,
        profitUSD: 0,
        errorMessage: msg,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  private encodeSwapSteps(steps: SwapStep[], loanAmount: bigint): string {
    const coder = AbiCoder.defaultAbiCoder();
    const encodedSteps = steps.map((step, index) => ({
      dexId: step.dexId,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      // [v3.3 Fix] Prevent unintended reserve swapping. If first step amountIn is 0, use loanAmount.
      amountIn: (index === 0 && step.amountIn === 0n) ? loanAmount : step.amountIn,
      fee: step.fee,
      extraData: step.extraData || "0x",
    }));

    return coder.encode(
      [
        "tuple(uint8 dexId, address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, bytes extraData)[]",
      ],
      [encodedSteps]
    );
  }

  async stressTest(
    path: ArbitragePath,
    iterations: number = EXECUTION.SIMULATION_ITERATIONS
  ): Promise<{ successRate: number; avgProfitUSD: number; results: SimulationResult[] }> {
    log.info(`🔨 Stress testing path ${path.id} for ${iterations} iterations`);

    const results: SimulationResult[] = [];
    let successCount = 0;
    let totalProfit = 0;

    for (let i = 0; i < iterations; i++) {
      const result = await this.simulateSinglePath(path);
      results.push(result);
      if (result.success) {
        successCount++;
        totalProfit += result.profitUSD;
      }

      if ((i + 1) % 100 === 0) {
        log.debug(`  Progress: ${i + 1}/${iterations} (${successCount} successful)`);
      }
    }

    const successRate = (successCount / iterations) * 100;
    const avgProfit = successCount > 0 ? totalProfit / successCount : 0;

    log.info(
      `📊 Stress test: ${successRate.toFixed(1)}% success, avg profit: $${avgProfit.toFixed(2)}`
    );

    return { successRate, avgProfitUSD: avgProfit, results };
  }
}
