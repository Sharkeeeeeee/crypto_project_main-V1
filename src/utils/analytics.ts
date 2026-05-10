/**
 * IronShield Analytics Engine
 * Tracks execution metrics, profit/loss, and failure analysis
 */
import fs from "fs";
import path from "path";
import { createModuleLogger } from "./logger";
import { ExecutionResult, SimulationResult } from "../config/config";

const log = createModuleLogger("ANALYTICS");

interface AnalyticsState {
  startTime: number;
  totalScans: number;
  totalSimulations: number;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  totalProfitWei: bigint;
  totalGasSpentWei: bigint;
  executionHistory: ExecutionRecord[];
  failureReasons: Map<string, number>;
  hourlyProfits: Map<string, number>;
}

interface ExecutionRecord {
  timestamp: number;
  txHash: string;
  success: boolean;
  profitWei: string;
  gasUsedWei: string;
  path: string;
  errorMessage?: string;
}

class AnalyticsTracker {
  private state: AnalyticsState;
  private dataFile: string;

  constructor() {
    this.dataFile = path.join("./logs", "analytics.json");
    this.state = this.loadState();
  }

  private loadState(): AnalyticsState {
    try {
      if (fs.existsSync(this.dataFile)) {
        const data = JSON.parse(fs.readFileSync(this.dataFile, "utf-8"));
        return {
          ...data,
          totalProfitWei: BigInt(data.totalProfitWei || "0"),
          totalGasSpentWei: BigInt(data.totalGasSpentWei || "0"),
          failureReasons: new Map(Object.entries(data.failureReasons || {})),
          hourlyProfits: new Map(Object.entries(data.hourlyProfits || {})),
        };
      }
    } catch (e) {
      log.warn("Failed to load analytics state, starting fresh");
    }

    return {
      startTime: Date.now(),
      totalScans: 0,
      totalSimulations: 0,
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      totalProfitWei: 0n,
      totalGasSpentWei: 0n,
      executionHistory: [],
      failureReasons: new Map(),
      hourlyProfits: new Map(),
    };
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.dataFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const serializable = {
        ...this.state,
        totalProfitWei: this.state.totalProfitWei.toString(),
        totalGasSpentWei: this.state.totalGasSpentWei.toString(),
        failureReasons: Object.fromEntries(this.state.failureReasons),
        hourlyProfits: Object.fromEntries(this.state.hourlyProfits),
      };
      fs.writeFileSync(this.dataFile, JSON.stringify(serializable, null, 2));
    } catch (e) {
      log.error("Failed to save analytics state");
    }
  }

  recordScan(): void {
    this.state.totalScans++;
  }

  recordSimulation(result: SimulationResult): void {
    this.state.totalSimulations++;
  }

  recordExecution(result: ExecutionResult, pathDesc: string): void {
    this.state.totalExecutions++;

    if (result.success) {
      this.state.successfulExecutions++;
      this.state.totalProfitWei += result.profit;

      const hourKey = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
      const currentHourly = this.state.hourlyProfits.get(hourKey) || 0;
      this.state.hourlyProfits.set(
        hourKey,
        currentHourly + Number(result.profit)
      );
    } else {
      this.state.failedExecutions++;
      const reason = result.errorMessage || "Unknown";
      this.state.failureReasons.set(
        reason,
        (this.state.failureReasons.get(reason) || 0) + 1
      );
    }

    this.state.totalGasSpentWei += result.gasUsed;

    this.state.executionHistory.push({
      timestamp: result.timestamp,
      txHash: result.txHash,
      success: result.success,
      profitWei: result.profit.toString(),
      gasUsedWei: result.gasUsed.toString(),
      path: pathDesc,
      errorMessage: result.errorMessage,
    });

    // Keep only last 1000 records
    if (this.state.executionHistory.length > 1000) {
      this.state.executionHistory = this.state.executionHistory.slice(-1000);
    }

    this.saveState();
  }

  generateReport(): string {
    const uptimeMs = Date.now() - this.state.startTime;
    const uptimeHours = (uptimeMs / 3600000).toFixed(1);
    const successRate =
      this.state.totalExecutions > 0
        ? ((this.state.successfulExecutions / this.state.totalExecutions) * 100).toFixed(1)
        : "0";

    const topFailures = [...this.state.failureReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => `    ${reason}: ${count}`)
      .join("\n");

    return `
╔══════════════════════════════════════════════════════╗
║         🛡️  IronShield Analytics Report              ║
╠══════════════════════════════════════════════════════╣
║  Uptime:              ${uptimeHours.padStart(8)} hours               ║
║  Total Scans:         ${String(this.state.totalScans).padStart(8)}                    ║
║  Total Simulations:   ${String(this.state.totalSimulations).padStart(8)}                    ║
║  Total Executions:    ${String(this.state.totalExecutions).padStart(8)}                    ║
║  Successful:          ${String(this.state.successfulExecutions).padStart(8)}                    ║
║  Failed:              ${String(this.state.failedExecutions).padStart(8)}                    ║
║  Success Rate:        ${successRate.padStart(7)}%                    ║
║  Total Profit:        ${this.state.totalProfitWei.toString().padStart(8)} wei             ║
║  Total Gas Spent:     ${this.state.totalGasSpentWei.toString().padStart(8)} wei             ║
╠══════════════════════════════════════════════════════╣
║  Top Failure Reasons:                                ║
${topFailures || "    None"}
╚══════════════════════════════════════════════════════╝`;
  }
}

export const analytics = new AnalyticsTracker();

// If run directly, print report
if (require.main === module) {
  console.log(analytics.generateReport());
}
