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

    // [v4.7] Concise diagnostic for rejected paths
    const failedPaths = results.filter((r) => !r.success || r.profitUSD < EXECUTION.MIN_PROFIT_USD);
    if (failedPaths.length > 0) {
      failedPaths.forEach((r) => {
        if (r.errorMessage) {
          const isLowProfit = r.errorMessage.includes("0x82b42900");
          const reason = isLowProfit ? "Insufficient Net Profit (after fees/impact)" : r.errorMessage.split("(")[0].trim();
          log.info(`   ↳ ❌ Rejected: ${reason}`);
        } else {
          log.info(`   ↳ ❌ Below Min Profit: Net $${r.profitUSD.toFixed(4)}`);
        }
      });
    }

    return results;
  }

  private async simulateSinglePath(path: ArbitragePath): Promise<SimulationResult> {
    const startTime = Date.now();
    const provider = this.forkEngine.getProvider();
    
    // [v6.2] Scaling Strategy: Try multiple loan amounts if initial fails
    const initialLoan = path.loanAmount || EXECUTION.DEFAULT_LOAN_AMOUNT;
    const scalingFactors = [100n, 50n, 25n]; // Try 100%, 50%, 25%
    let bestResult: SimulationResult | null = null;

    for (const factor of scalingFactors) {
      try {
        const loanAmount = (initialLoan * factor) / 100n;
        if (loanAmount < ethers.parseUnits("0.05", 18) && path.steps[0].tokenIn === ADDRESSES.WETH) break; // Don't bother with tiny trades

        const encodedSteps = this.encodeSwapSteps(path.steps, loanAmount);
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const minProfit = 0n;
        
        const assetAddress = path.steps[0].tokenIn;
        const assetDecimals = getAssetDecimals(assetAddress);
        const executor = new Contract(this.executorAddress, EXECUTOR_ABI, provider);
        
        const callData = executor.interface.encodeFunctionData("initiateArbitrage", [
          assetAddress, loanAmount, minProfit, deadline, encodedSteps,
        ]);

        // [v6.6 Fix] Use the actual owner wallet address to bypass onlyOwner modifier during simulation
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!);
        const signerAddr = wallet.address;

        const simResult = await this.forkEngine.simulateAndGetBalanceChange(
          this.executorAddress, callData, signerAddr, assetAddress
        );

        if (!simResult.success) {
          const err = simResult.error?.toLowerCase() || "";
          // If it's InsufficientProfit, SwapFailed (0xd229d4ee) or generic revert, we continue to smaller scale
          if (err.includes("0x82b42900") || err.includes("0xd229d4ee") || err.includes("revert") || err.includes("profit") || err.includes("insufficient")) {
             log.info(`      📉 Scaling: ${factor}% failed (${err.slice(0, 40)}...). Retrying...`);
             continue;
          }
          log.warn(`      ❌ Fatal Scaling Error: ${err}`);
          if (!bestResult) {
            bestResult = { path, success: false, outputAmount: 0n, gasUsed: 0n, netProfit: 0n, profitUSD: 0, errorMessage: simResult.error, executionTimeMs: Date.now() - startTime };
          }
          break;
        }

        const gasPrice = await this.forkEngine.getGasPrice();
        const ethPrice = await getEthPriceUSD();
        const assetPriceUSD = path.assetPriceUSD || (assetAddress.toLowerCase() === ADDRESSES.WETH.toLowerCase() ? ethPrice : 1.0);

        let actualOutput = simResult.outputAmount;
        if (simResult.outputAmount === 1n) {
           actualOutput = loanAmount + (path.estimatedProfit * factor / 100n);
        }

        const profitInfo = await this.profitCalc.calculateNetProfit(
          loanAmount, actualOutput, simResult.gasUsed, gasPrice, assetDecimals, assetPriceUSD, callData
        );

        const currentResult: SimulationResult = {
          path: { ...path, loanAmount }, 
          success: profitInfo.isProfitable,
          outputAmount: simResult.outputAmount,
          gasUsed: simResult.gasUsed,
          netProfit: profitInfo.contractProfitRaw,
          profitUSD: profitInfo.netProfitUSD,
          executionTimeMs: Date.now() - startTime,
        };

        log.debug(
          `      🔍 Scale ${factor}%: ` +
          `Gross: $${profitInfo.contractProfitUSD.toFixed(3)} | ` +
          `Gas: $${profitInfo.totalGasCostUSD.toFixed(3)} | ` +
          `Net: $${profitInfo.netProfitUSD.toFixed(3)}`
        );

        if (profitInfo.meetsThreshold) {
          log.info(`   💰 Profitable at ${factor}% scale: $${profitInfo.netProfitUSD.toFixed(2)}`);
          return currentResult;
        } else {
          if (!bestResult || currentResult.profitUSD > bestResult.profitUSD) bestResult = currentResult;
        }
      } catch (e) {
        log.debug(`      ❌ Scaling error at ${factor}%: ${e}`);
        break;
      }
    }

    return bestResult || {
      path, success: false, outputAmount: 0n, gasUsed: 0n, netProfit: 0n, profitUSD: 0,
      errorMessage: "All scaling attempts failed", executionTimeMs: Date.now() - startTime,
    };
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
