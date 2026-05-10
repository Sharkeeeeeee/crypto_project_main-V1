/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         🛡️  IronShield Atomic Arbitrage Engine           ║
 * ║         Base Chain MEV Tactical System v1.0              ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  Modules:                                                ║
 * ║   1. The Filter    — Smart token/pool filtering          ║
 * ║   2. The Simulator — Fork-based path optimization        ║
 * ║   3. The Executor  — Atomic flash loan arbitrage         ║
 * ║   4. Ghost Protocol — Private sequencer submission       ║
 * ╚══════════════════════════════════════════════════════════╝
 */

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import { createModuleLogger, createHourlyBackup } from "./utils/logger";
import { analytics } from "./utils/analytics";
import { getEthPriceUSD } from "./utils/prices";

// Module imports
import { PoolScanner } from "./filter/poolScanner";
import { TokenAuditor } from "./filter/tokenAuditor";
import { HoneypotDetector } from "./filter/honeypotDetector";
import { WhitelistManager } from "./filter/whitelist";
import { ForkEngine } from "./simulator/forkEngine";
import { PathOptimizer } from "./simulator/pathOptimizer";
import { ProfitCalculator } from "./simulator/profitCalculator";
import { ContractDeployer } from "./executor/contractDeployer";
import { TransactionBuilder } from "./executor/transactionBuilder";
import { PrivateRpcManager } from "./ghost/privateRpc";
import { NonceManager } from "./ghost/nonceManager";
import { Notifier } from "./utils/notifier";

// Config
import {
  ADDRESSES,
  EXECUTION,
  SCANNER,
  RPC,
  ArbitragePath,
  SimulationResult,
} from "./config/config";

const log = createModuleLogger("CORE");

// ══════════════════════════════════════════════════════════════
//  IRONSHIELD ENGINE
// ══════════════════════════════════════════════════════════════

class IronShieldEngine {
  // Module instances
  private scanner!: PoolScanner;
  private auditor!: TokenAuditor;
  private honeypot!: HoneypotDetector;
  private whitelist!: WhitelistManager;
  private forkEngine!: ForkEngine;
  private optimizer!: PathOptimizer;
  private profitCalc!: ProfitCalculator;
  private txBuilder!: TransactionBuilder;
  private ghostRpc!: PrivateRpcManager;
  private nonceManager!: NonceManager;

  // State
  private isRunning: boolean = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private backupTimer: NodeJS.Timeout | null = null;
  private cycleCount: number = 0;

  /**
   * Initialize all modules and start the engine
   */
  async initialize(): Promise<void> {
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║                                                          ║
    ║         🛡️  IronShield Atomic Arbitrage Engine            ║
    ║         ─────────────────────────────────────             ║
    ║         Base Chain | Flash Loan Arbitrage                 ║
    ║         Zero Principal Risk | Private Execution           ║
    ║                                                          ║
    ╚══════════════════════════════════════════════════════════╝
    `);

    log.info("Initializing IronShield engine...");

    // Validate environment
    this.validateConfig();

    // Initialize Ghost Protocol (private RPC first)
    this.ghostRpc = new PrivateRpcManager();
    const provider = this.ghostRpc.getProvider();

    // Health check RPCs
    const health = await this.ghostRpc.healthCheck();
    log.info(
      `RPC Health — Primary: ${health.primary.healthy ? "✅" : "❌"} (${health.primary.latencyMs}ms), ` +
      `Fallback: ${health.fallback.healthy ? "✅" : "❌"} (${health.fallback.latencyMs}ms)`
    );

    if (!health.primary.healthy && !health.fallback.healthy) {
      throw new Error("❌ No healthy RPC endpoints available");
    }

    // Check chain ID
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== RPC.CHAIN_ID) {
      throw new Error(`Wrong chain! Expected ${RPC.CHAIN_ID}, got ${network.chainId}`);
    }
    log.info(`Connected to Base (Chain ID: ${network.chainId})`);

    // Check wallet balance
    const privateKey = process.env.PRIVATE_KEY!;
    const wallet = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(wallet.address);
    const balanceETH = ethers.formatEther(balance);
    log.info(`Wallet: ${wallet.address} | Balance: ${balanceETH} ETH`);

    if (balance < ethers.parseEther("0.01")) {
      log.warn("⚠️ Low ETH balance! Ensure at least $50 in gas reserves.");
    }

    // Initialize Filter modules
    this.scanner = new PoolScanner(provider);
    this.auditor = new TokenAuditor(process.env.BASESCAN_API_KEY || "");
    this.honeypot = new HoneypotDetector(provider);
    this.whitelist = new WhitelistManager();

    // Initialize Simulator modules
    // [v3.1] Pass shared provider to ForkEngine so it doesn't create
    // a second unthrottled connection to Tatum (prevents RPS overflow)
    this.forkEngine = new ForkEngine(provider as ethers.JsonRpcProvider);
    await this.forkEngine.initialize();
    // [v3.0] ProfitCalculator needs provider for OP Stack Gas Oracle queries
    this.profitCalc = new ProfitCalculator(provider as ethers.JsonRpcProvider);

    // Initialize Executor
    const executorAddress = process.env.EXECUTOR_CONTRACT_ADDRESS;
    if (executorAddress) {
      this.txBuilder = new TransactionBuilder(provider, privateKey, executorAddress);
      this.optimizer = new PathOptimizer(this.forkEngine, this.profitCalc, executorAddress);
      log.info(`Executor contract: ${executorAddress}`);
    } else {
      log.warn("⚠️ No executor contract deployed. Run deployment first.");
    }

    // Initialize Nonce Manager with wallet key for queue-based tx sending
    this.nonceManager = new NonceManager(
      provider as ethers.JsonRpcProvider,
      wallet.address,
      privateKey
    );
    await this.nonceManager.initialize();

    log.info("✅ All modules initialized successfully");
  }

  /**
   * Start the main scanning loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      log.warn("Engine is already running");
      return;
    }

    this.isRunning = true;
    log.info(`🚀 Engine started! Scan interval: ${SCANNER.SCAN_INTERVAL_MS}ms`);
    
    await Notifier.notifySystem(
      "🚀 Engine Started",
      `Mode: ${process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] || "full"}\nScan Interval: ${SCANNER.SCAN_INTERVAL_MS}ms`
    );

    // Start hourly backup timer
    this.backupTimer = setInterval(() => {
      createHourlyBackup();
      log.info(analytics.generateReport());
    }, 3600000); // Every hour

    // Main loop
    await this.runScanCycle();

    this.scanTimer = setInterval(async () => {
      if (this.isRunning && !(this as any).isScanning) {
        (this as any).isScanning = true;
        try {
          await this.runScanCycle();
        } finally {
          (this as any).isScanning = false;
        }
      }
    }, SCANNER.SCAN_INTERVAL_MS);
  }

  /**
   * Execute one complete scan → simulate → execute cycle
   */
  private async runScanCycle(): Promise<void> {
    this.cycleCount++;
    const cycleStart = Date.now();
    log.info(`━━━ Cycle #${this.cycleCount} ━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    try {
      // ── Phase 1: Scan for opportunities ──────────────────
      analytics.recordScan();
      const discrepancies = await this.scanner.scanForOpportunities();

      if (discrepancies.length === 0) {
        log.debug("No opportunities found this cycle");
        return;
      }

      // Build arbitrage paths from discrepancies
      const paths = await this.scanner.buildArbitragePaths(discrepancies);
      log.debug(`📊 ${paths.length} potential paths identified`);

      // ── Phase 2: Filter & Audit tokens ───────────────────
      const safePaths = await this.filterPaths(paths);
      if (safePaths.length === 0) {
        log.debug("No paths passed safety filters");
        return;
      }

      // ── Phase 3: Simulate on fork ────────────────────────
      if (!this.optimizer) {
        log.warn("Optimizer not initialized (deploy contract first)");
        return;
      }

      const simResults = await this.optimizer.simulatePaths(safePaths);
      const profitablePaths = simResults.filter(
        (r) => r.success && r.profitUSD >= EXECUTION.MIN_PROFIT_USD
      );

      if (profitablePaths.length === 0) {
        log.debug("No profitable paths after simulation");
        return;
      }

      // [v3.1] Notify high-profit opportunities (> $5.0 USD)
      const topOp = profitablePaths[0];
      if (topOp.profitUSD >= 5.0) {
        const routeStr = topOp.path.steps.map(s => `${s.dexId === 0 ? "AERO" : s.dexId === 1 ? "UniV3" : "BaseSwap"}`).join(" → ");
        await Notifier.notifyOpportunity(
          topOp.path.steps[0].tokenIn,
          topOp.profitUSD,
          0,
          routeStr
        );
      }

      // ── Phase 4: Execute best path ───────────────────────
      const bestPath = profitablePaths[0]; // Already sorted by profit
      log.info(
        `🎯 Best opportunity: $${bestPath.profitUSD.toFixed(2)} profit | ` +
        `Gas: ${bestPath.gasUsed} units`
      );

      // Stress test the best path
      const stressResult = await this.optimizer.stressTest(bestPath.path, 10);
      if (stressResult.successRate < 100) {
        log.warn(
          `⚠️ Path failed stress test (${stressResult.successRate}% success). Skipping.`
        );
        return;
      }

      // Execute!
      if (this.txBuilder) {
        await this.executeArbitrage(bestPath);
      }
    } catch (error: any) {
      log.error(`Cycle #${this.cycleCount} error: ${error.message}`);
    }

    const cycleDuration = Date.now() - cycleStart;
    log.info(`Cycle #${this.cycleCount} completed in ${cycleDuration}ms`);
  }

  /**
   * Filter paths through safety checks (audit + honeypot)
   */
  private async filterPaths(paths: ArbitragePath[]): Promise<ArbitragePath[]> {
    const safePaths: ArbitragePath[] = [];

    for (const path of paths) {
      let isSafe = true;

      for (const step of path.steps) {
        // Check if tokens are already blacklisted
        if (this.honeypot.isBlacklisted(step.tokenIn) || this.honeypot.isBlacklisted(step.tokenOut)) {
          isSafe = false;
          break;
        }

        // Skip core tokens (WETH, USDC, etc.) from auditing
        const coreTokens = [ADDRESSES.WETH, ADDRESSES.USDC, ADDRESSES.USDbC, ADDRESSES.DAI];
        const tokensToAudit = [step.tokenIn, step.tokenOut].filter(
          (t) => !coreTokens.some((ct) => ct.toLowerCase() === t.toLowerCase())
        );

        for (const token of tokensToAudit) {
          const auditResult = await this.auditor.auditToken(token);
          if (!auditResult.isClean) {
            log.warn(`🚫 Token ${token} failed audit (risk: ${auditResult.riskScore})`);
            isSafe = false;
            break;
          }
        }

        if (!isSafe) break;
      }

      if (isSafe) safePaths.push(path);
    }

    log.debug(`🔒 ${safePaths.length}/${paths.length} paths passed safety filters`);
    return safePaths;
  }

  /**
   * Execute an arbitrage opportunity
   */
  private async executeArbitrage(simResult: SimulationResult): Promise<void> {
    try {
      log.info("⚡ EXECUTING ARBITRAGE ⚡");
      const tx = await this.txBuilder.executeArbitrage(simResult.path);

      // Wait for confirmation via Ghost Protocol
      const receipt = await this.ghostRpc.waitForConfirmation(tx.hash);

      if (receipt && receipt.status === 1) {
        const gasUsedWei = receipt.gasUsed * receipt.gasPrice;
        analytics.recordExecution(
          {
            txHash: tx.hash,
            success: true,
            profit: simResult.netProfit,
            gasUsed: gasUsedWei,
            blockNumber: receipt.blockNumber,
            timestamp: Date.now(),
          },
          simResult.path.id
        );
        log.profit(`Arbitrage SUCCESS! TX: ${tx.hash}`, {
          profit: simResult.profitUSD,
          gas: ethers.formatEther(gasUsedWei),
        });

        await Notifier.notifyProfit(
          simResult.path.steps[0].tokenIn,
          simResult.profitUSD,
          tx.hash,
          Number(ethers.formatEther(gasUsedWei)) * (await getEthPriceUSD())
        );
      } else {
        analytics.recordExecution(
          {
            txHash: tx.hash,
            success: false,
            profit: 0n,
            gasUsed: receipt ? receipt.gasUsed * receipt.gasPrice : 0n,
            blockNumber: receipt?.blockNumber || 0,
            timestamp: Date.now(),
            errorMessage: "Transaction reverted",
          },
          simResult.path.id
        );
        log.error(`Arbitrage FAILED: TX reverted ${tx.hash}`);
        await Notifier.notifyFailure(tx.hash, "Transaction reverted", simResult.profitUSD);
      }
    } catch (error: any) {
      log.error(`Execution error: ${error.message}`);
      analytics.recordExecution(
        {
          txHash: "0x",
          success: false,
          profit: 0n,
          gasUsed: 0n,
          blockNumber: 0,
          timestamp: Date.now(),
          errorMessage: error.message,
        },
        simResult.path.id
      );
    }
  }

  /**
   * Validate required environment variables
   */
  private validateConfig(): void {
    if (!process.env.PRIVATE_KEY) {
      throw new Error("PRIVATE_KEY not set in .env");
    }
    if (!process.env.BASE_RPC_URL || process.env.BASE_RPC_URL.includes("mainnet.base.org")) {
      log.warn("⚠️ Using public RPC! Configure a private endpoint (Alchemy/QuickNode) for production.");
    }
  }

  /**
   * Graceful shutdown
   */
  async stop(): Promise<void> {
    log.info("🛑 Shutting down IronShield engine...");
    this.isRunning = false;

    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.backupTimer) clearInterval(this.backupTimer);

    createHourlyBackup();
    log.info(analytics.generateReport());
    log.info("👋 Engine stopped. See you next time.");
  }
}

// ══════════════════════════════════════════════════════════════
//  ENTRY POINT
// ══════════════════════════════════════════════════════════════

async function main() {
  const engine = new IronShieldEngine();

  // Parse command line mode
  const mode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] || "full";

  try {
    await engine.initialize();

    switch (mode) {
      case "scan":
        log.info("Running in SCAN-ONLY mode");
        // Run single scan cycle without execution
        await engine.start();
        setTimeout(() => engine.stop(), 30000); // Stop after 30s
        break;

      case "simulate":
        log.info("Running in SIMULATION mode (no real execution)");
        await engine.start();
        break;

      case "execute":
      case "full":
      default:
        log.info("Running in FULL EXECUTION mode");
        await engine.start();
        break;
    }

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      await engine.stop();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await engine.stop();
      process.exit(0);
    });
  } catch (error: any) {
    log.error(`Fatal error: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
