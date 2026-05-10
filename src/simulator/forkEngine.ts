/**
 * IronShield Fork Engine (The Simulator - Module 2a)
 * Manages Anvil/Hardhat fork for simulation environment
 * Optimized for multi-threaded path evaluation
 */
import { ethers } from "ethers";
import { createModuleLogger } from "../utils/logger";
import { RPC } from "../config/config";

const log = createModuleLogger("FORK");

export class ForkEngine {
  private provider: ethers.JsonRpcProvider;
  private forkBlockNumber: number = 0;
  private isReady: boolean = false;
  private supportsSnapshots: boolean = true;

  /**
   * @param providerOrUrl  Pass an existing rate-limited provider to share
   *                       the same connection budget, OR a URL string to
   *                       create a standalone provider (with Tatum headers).
   *
   * [v3.1] In production, ALWAYS pass the PrivateRpcManager's provider.
   * Creating a second independent provider doubles the RPS hitting Tatum
   * and triggers "exceeded maximum retry limit" errors from cycle 7+.
   */
  constructor(providerOrUrl?: ethers.JsonRpcProvider | string) {
    if (providerOrUrl instanceof ethers.JsonRpcProvider) {
      // Reuse an existing rate-limited provider (recommended)
      this.provider = providerOrUrl;
      log.info("ForkEngine using shared rate-limited provider");
    } else {
      // Fallback: create a standalone provider
      const url = providerOrUrl || RPC.PRIMARY;
      const baseNetwork = ethers.Network.from(RPC.CHAIN_ID);

      let fetchTarget: string | ethers.FetchRequest = url;
      if (RPC.TATUM_API_KEY && url.toLowerCase().includes("tatum")) {
        const fetchReq = new ethers.FetchRequest(url);
        fetchReq.setHeader("x-api-key", RPC.TATUM_API_KEY);
        fetchTarget = fetchReq;
      }

      this.provider = new ethers.JsonRpcProvider(
        fetchTarget,
        baseNetwork,
        { batchMaxCount: 1, staticNetwork: baseNetwork }
      );
      log.info("ForkEngine created standalone provider");
    }
  }

  /**
   * Initialize fork at latest block
   * When using Hardhat Network (local), the fork is auto-configured
   */
  async initialize(): Promise<void> {
    try {
      const block = await this.provider.getBlockNumber();
      this.forkBlockNumber = block;
      
      // [v3.6] Detect snapshot support
      try {
        await this.provider.send("evm_snapshot", []);
        log.info("✅ Snapshot support detected (Local Fork Mode)");
        this.supportsSnapshots = true;
      } catch {
        this.supportsSnapshots = false;
        log.warn("⚠️ Snapshot NOT supported (Public RPC Mode). Simulation will be read-only.");
      }

      this.isReady = true;
      log.info(`🔗 Fork initialized at block #${block}`);
    } catch (error: any) {
      log.error(`Fork initialization failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create a snapshot for rollback after simulation
   */
  async createSnapshot(): Promise<string> {
    if (!this.supportsSnapshots) return "0x0";
    try {
      const snapshotId = await this.provider.send("evm_snapshot", []);
      return snapshotId;
    } catch (error: any) {
      log.debug(`Snapshot failed: ${error.message}`);
      return "0x0";
    }
  }

  /**
   * Revert to a previous snapshot
   */
  async revertSnapshot(snapshotId: string): Promise<void> {
    if (!this.supportsSnapshots || snapshotId === "0x0") return;
    try {
      await this.provider.send("evm_revert", [snapshotId]);
    } catch (error: any) {
      log.debug(`Revert failed: ${error.message}`);
    }
  }

  /**
   * Simulate a transaction and return the result
   */
  async simulateTransaction(
    to: string,
    data: string,
    from: string,
    value: bigint = 0n
  ): Promise<{ success: boolean; gasUsed: bigint; returnData: string; error?: string }> {
    try {
      // Use eth_call for dry-run
      const result = await this.provider.call({
        to,
        data,
        from,
        value,
      });

      // Estimate gas
      const gasEstimate = await this.provider.estimateGas({
        to,
        data,
        from,
        value,
      });

      return {
        success: true,
        gasUsed: gasEstimate,
        returnData: result,
      };
    } catch (error: any) {
      return {
        success: false,
        gasUsed: 0n,
        returnData: "0x",
        error: error.message,
      };
    }
  }

  /**
   * [v3.5] Advanced simulation: executes tx and checks balance change
   */
  async simulateAndGetBalanceChange(
    to: string,
    data: string,
    from: string,
    asset: string,
    value: bigint = 0n
  ): Promise<{ success: boolean; gasUsed: bigint; outputAmount: bigint; error?: string }> {
    // [v3.6 Fallback] If snapshots are not supported, use simple eth_call
    if (!this.supportsSnapshots) {
      try {
        const gasUsed = await this.provider.estimateGas({ from, to, data, value });
        await this.provider.call({ from, to, data, value });
        
        // On public RPC without snapshots, we can't easily get the balance change
        // after the swap in a single call. We fallback to returning a 1:1 success
        // or using the path's estimated profit as a proxy.
        return {
          success: true,
          gasUsed,
          outputAmount: 1n, // Placeholder: indicates success
        };
      } catch (error: any) {
        return { success: false, gasUsed: 0n, outputAmount: 0n, error: error.message };
      }
    }

    const snapshotId = await this.createSnapshot();
    try {
      const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
      const token = new ethers.Contract(asset, ERC20_ABI, this.provider);
      
      const balanceBefore = await token.balanceOf(to);
      
      const tx = await this.provider.send("eth_sendTransaction", [{
        from, to, data, value: value.toString()
      }]);
      
      const receipt = await this.provider.getTransactionReceipt(tx);
      if (!receipt || receipt.status === 0) {
        throw new Error("Transaction failed on fork");
      }
      
      const balanceAfter = await token.balanceOf(to);
      
      return {
        success: true,
        gasUsed: receipt.gasUsed,
        outputAmount: balanceAfter,
      };
    } catch (error: any) {
      return {
        success: false,
        gasUsed: 0n,
        outputAmount: 0n,
        error: error.message,
      };
    } finally {
      await this.revertSnapshot(snapshotId);
    }
  }

  /**
   * Get current gas price from the fork
   */
  async getGasPrice(): Promise<bigint> {
    const feeData = await this.provider.getFeeData();
    return feeData.gasPrice || 0n;
  }

  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  getBlockNumber(): number {
    return this.forkBlockNumber;
  }

  isInitialized(): boolean {
    return this.isReady;
  }
}
