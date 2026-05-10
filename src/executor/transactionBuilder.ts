/**
 * IronShield Transaction Builder (The Executor - Module 3b)
 * Builds and encodes arbitrage transactions for the executor contract
 */
import { ethers, Contract, AbiCoder } from "ethers";
import { createModuleLogger } from "../utils/logger";
import { ArbitragePath, SwapStep, EXECUTION, ADDRESSES } from "../config/config";

const log = createModuleLogger("TX_BUILD");

const EXECUTOR_ABI = [
  "function initiateArbitrage(address asset, uint256 amount, bytes swapData) external",
  "function blacklistToken(address token, string reason) external",
  "function setMinProfit(uint256 _minProfitWei) external",
  "function setPaused(bool _paused) external",
  "function withdrawProfit(address token, uint256 amount) external",
  "function withdrawETH() external",
  "function totalExecutions() view returns (uint256)",
  "function totalProfit() view returns (uint256)",
  "function paused() view returns (bool)",
  "function minProfitWei() view returns (uint256)",
];

export class TransactionBuilder {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private executorContract: Contract;

  constructor(
    provider: ethers.JsonRpcProvider,
    privateKey: string,
    executorAddress: string
  ) {
    this.provider = provider;
    this.wallet = new ethers.Wallet(privateKey, provider);
    this.executorContract = new Contract(executorAddress, EXECUTOR_ABI, this.wallet);
  }

  /**
   * Build and send an arbitrage transaction
   */
  async executeArbitrage(
    path: ArbitragePath
  ): Promise<ethers.TransactionResponse> {
    const loanAmount = path.loanAmount || EXECUTION.DEFAULT_LOAN_AMOUNT;
    const assetAddress = path.steps[0].tokenIn;

    log.info(`🎯 Building arbitrage TX for path: ${path.id} (Loan: ${ethers.formatUnits(loanAmount, 18)})`);

    // [v3.3 Fix] Pass loanAmount to encodeSwapSteps to prevent reserve swapping
    const swapData = this.encodeSwapSteps(path.steps, loanAmount);

    // Build transaction with optimized gas settings
    const feeData = await this.provider.getFeeData();
    const gasEstimate = await this.executorContract.initiateArbitrage.estimateGas(
      assetAddress,
      loanAmount,
      swapData
    );

    // Add gas buffer
    const gasLimit = (gasEstimate * 120n) / 100n;

    log.info(
      `  Gas estimate: ${gasEstimate} (limit: ${gasLimit}), ` +
      `Price: ${ethers.formatUnits(feeData.gasPrice || 0n, "gwei")} gwei`
    );

    // Check gas price safety cap
    const maxGasWei = ethers.parseUnits(String(EXECUTION.MAX_GAS_PRICE_GWEI), "gwei");
    if (feeData.gasPrice && feeData.gasPrice > maxGasWei) {
      throw new Error(
        `Gas price ${ethers.formatUnits(feeData.gasPrice, "gwei")} gwei exceeds cap ` +
        `${EXECUTION.MAX_GAS_PRICE_GWEI} gwei`
      );
    }

    // Send transaction
    const tx = await this.executorContract.initiateArbitrage(
      assetAddress,
      loanAmount,
      swapData,
      {
        gasLimit,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      }
    );

    log.info(`📤 TX submitted: ${tx.hash}`);
    return tx;
  }

  /**
   * Encode swap steps for the Solidity contract
   */
  private encodeSwapSteps(steps: SwapStep[], loanAmount: bigint): string {
    const coder = AbiCoder.defaultAbiCoder();
    const encoded = steps.map((step, index) => [
      step.dexId,
      step.tokenIn,
      step.tokenOut,
      // [v3.3 Fix] Prevent unintended reserve swapping. If first step amountIn is 0, use loanAmount.
      (index === 0 && step.amountIn === 0n) ? loanAmount : step.amountIn,
      step.fee,
      step.extraData || "0x",
    ]);

    return coder.encode(
      ["tuple(uint8,address,address,uint256,uint24,bytes)[]"],
      [encoded]
    );
  }

  /**
   * Blacklist a token on the executor contract
   */
  async blacklistToken(token: string, reason: string): Promise<void> {
    const tx = await this.executorContract.blacklistToken(token, reason);
    await tx.wait();
    log.info(`🚫 Token blacklisted on-chain: ${token}`);
  }

  /**
   * Withdraw profits from the executor contract
   */
  async withdrawProfits(token: string, amount: bigint): Promise<void> {
    const tx = await this.executorContract.withdrawProfit(token, amount);
    await tx.wait();
    log.info(`💸 Withdrew ${ethers.formatEther(amount)} ETH in profits`);
  }

  /**
   * Get executor contract stats
   */
  async getStats(): Promise<{ executions: bigint; profit: bigint; paused: boolean }> {
    const [executions, profit, paused] = await Promise.all([
      this.executorContract.totalExecutions(),
      this.executorContract.totalProfit(),
      this.executorContract.paused(),
    ]);
    return { executions, profit, paused };
  }

  /**
   * Emergency pause the executor
   */
  async emergencyPause(): Promise<void> {
    const tx = await this.executorContract.setPaused(true);
    await tx.wait();
    log.warn("⚠️ Executor PAUSED");
  }

  /**
   * Resume executor operations
   */
  async resume(): Promise<void> {
    const tx = await this.executorContract.setPaused(false);
    await tx.wait();
    log.info("▶️ Executor RESUMED");
  }
}
