/**
 * IronShield Contract Deployer (The Executor - Module 3a)
 * Deploys and manages the IronShieldExecutor contract
 */
import { ethers, ContractFactory } from "ethers";
import fs from "fs";
import path from "path";
import { createModuleLogger } from "../utils/logger";

const log = createModuleLogger("DEPLOYER");

export class ContractDeployer {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;

  constructor(provider: ethers.JsonRpcProvider, privateKey: string) {
    this.provider = provider;
    this.wallet = new ethers.Wallet(privateKey, provider);
  }

  /**
   * Deploy the IronShieldExecutor contract
   */
  async deploy(
    aavePool: string,
    weth: string,
    minProfitWei: bigint
  ): Promise<string> {
    log.info("🚀 Deploying IronShieldExecutor...");

    try {
      // Load compiled artifact
      const artifactPath = path.join(
        process.cwd(),
        "artifacts",
        "contracts",
        "IronShieldExecutor.sol",
        "IronShieldExecutor.json"
      );

      if (!fs.existsSync(artifactPath)) {
        throw new Error("Contract not compiled. Run `npx hardhat compile` first.");
      }

      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
      const factory = new ContractFactory(
        artifact.abi,
        artifact.bytecode,
        this.wallet
      );

      const contract = await factory.deploy(aavePool, weth, minProfitWei);
      await contract.waitForDeployment();

      const address = await contract.getAddress();
      log.info(`✅ IronShieldExecutor deployed at: ${address}`);
      log.info(`   Owner: ${this.wallet.address}`);
      log.info(`   Aave Pool: ${aavePool}`);
      log.info(`   Min Profit: ${ethers.formatEther(minProfitWei)} ETH`);

      return address;
    } catch (error: any) {
      log.error(`Deployment failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Verify the deployed contract on BaseScan
   */
  async verify(contractAddress: string, constructorArgs: any[]): Promise<void> {
    log.info(`📋 Verify on BaseScan: npx hardhat verify --network base ${contractAddress} ${constructorArgs.join(" ")}`);
  }

  /**
   * Get the deployer wallet address
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Get deployer's ETH balance
   */
  async getBalance(): Promise<bigint> {
    return this.provider.getBalance(this.wallet.address);
  }
}
