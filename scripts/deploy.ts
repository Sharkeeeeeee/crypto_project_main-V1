/**
 * ════════════════════════════════════════════════════════════════
 *  IronShield Deployment Script
 *  Deploys IronShieldExecutor to Base mainnet or local fork
 *  Includes extensive MEV-grade logging for deployment analysis
 * ════════════════════════════════════════════════════════════════
 */
import { ethers, network } from "hardhat";

// ── Base Mainnet Canonical Addresses ────────────────────────────
// These are deterministic across all Base environments (mainnet + forks)
const BASE_ADDRESSES = {
  // Aave V3 Pool Proxy on Base (deployed by Aave governance)
  AAVE_V3_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  // Canonical WETH on Base (OP Stack predeploy)
  WETH: "0x4200000000000000000000000000000000000006",
  // Circle native USDC on Base
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;

// ── Minimum profit set to ~$1 USD in USDC (6 decimals) ──────────
// 1 USDC = 1_000_000 wei (6 decimals)
//
// ⚠️  IMPORTANT: minProfitWei is a GLOBAL threshold stored in the contract.
// It is compared against the arbitrage token's smallest unit.
// This value ($1 USDC = 1e6) is ONLY meaningful when borrowing USDC.
// If borrowing WETH (18 decimals), 1e6 wei ≈ $0.000000000001 — effectively zero.
// For multi-token support, consider implementing per-token thresholds in the contract.
const MIN_PROFIT_USDC_WEI = 1_000_000n; // $1.00 USDC

// Expected Base chainId — prevents accidental deployment to wrong network
const BASE_CHAIN_ID = 8453;

/**
 * Validates that a Base network address has deployed code.
 * Prevents deploying against a misconfigured fork or wrong chain.
 */
async function validateAddress(
  label: string,
  address: string
): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code === "0x0") {
    throw new Error(
      `[FATAL] ${label} at ${address} has no deployed code. ` +
      `Are you connected to Base mainnet or a valid fork?`
    );
  }
  console.log(`  [✓] ${label}: ${address} (code verified)`);
}

/**
 * Fetches and logs current network gas metrics.
 * On Base (L2), this reflects the L2 execution gas price.
 */
async function logGasMetrics(): Promise<void> {
  const feeData = await ethers.provider.getFeeData();

  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │           ⛽ GAS METRICS (Pre-Deploy)        │`);
  console.log(`  ├─────────────────────────────────────────────┤`);

  if (feeData.gasPrice !== null) {
    const gasPriceGwei = ethers.formatUnits(feeData.gasPrice, "gwei");
    console.log(`  │  Gas Price:        ${gasPriceGwei.padStart(18)} Gwei │`);
  }
  if (feeData.maxFeePerGas !== null) {
    const maxFeeGwei = ethers.formatUnits(feeData.maxFeePerGas, "gwei");
    console.log(`  │  Max Fee/Gas:      ${maxFeeGwei.padStart(18)} Gwei │`);
  }
  if (feeData.maxPriorityFeePerGas !== null) {
    const priorityGwei = ethers.formatUnits(
      feeData.maxPriorityFeePerGas,
      "gwei"
    );
    console.log(`  │  Priority Fee:     ${priorityGwei.padStart(18)} Gwei │`);
  }

  console.log(`  └─────────────────────────────────────────────┘`);
}

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log(`\n`);
  console.log(`  ╔═══════════════════════════════════════════════╗`);
  console.log(`  ║       🛡️  IRONSHIELD DEPLOYMENT ENGINE       ║`);
  console.log(`  ╚═══════════════════════════════════════════════╝`);

  // ── Chain ID validation ───────────────────────────────────────
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`  [INFO] Network:   ${network.name} (chainId: ${chainId})`);
  console.log(`  [INFO] Timestamp: ${new Date().toISOString()}`);

  if (Number(chainId) !== BASE_CHAIN_ID) {
    // Allow hardhat local fork (chainId is configured to 8453 in config)
    console.log(
      `  [WARN] ⚠️  ChainId ${chainId} does not match Base mainnet (${BASE_CHAIN_ID}).`
    );
    console.log(
      `  [WARN]     Proceeding — ensure this is an intentional fork deployment.`
    );
  }

  // ── Step 1: Deployer Identity & Balance ───────────────────────
  const [deployer] = await ethers.getSigners();
  const startBalance = await ethers.provider.getBalance(deployer.address);

  console.log(`\n  ── DEPLOYER ──────────────────────────────────`);
  console.log(`  [INFO] Address:   ${deployer.address}`);
  console.log(`  [INFO] Balance:   ${ethers.formatEther(startBalance)} ETH`);

  // Safety: warn if balance is dangerously low
  if (startBalance < ethers.parseEther("0.005")) {
    console.log(
      `  [WARN] ⚠️  Low deployer balance! Deployment may fail due to insufficient gas.`
    );
  }

  // ── Step 2: Gas Metrics ───────────────────────────────────────
  await logGasMetrics();

  // ── Step 3: Validate Base Network Addresses ───────────────────
  console.log(`\n  ── ADDRESS VALIDATION ────────────────────────`);
  await validateAddress("Aave V3 Pool", BASE_ADDRESSES.AAVE_V3_POOL);
  await validateAddress("WETH", BASE_ADDRESSES.WETH);
  await validateAddress("USDC", BASE_ADDRESSES.USDC);

  console.log(`\n  ── DEPLOYMENT ────────────────────────────────────────`);
  console.log(`  [INFO] Constructor args:`);
  console.log(`         aavePool: ${BASE_ADDRESSES.AAVE_V3_POOL}`);
  console.log(`         weth:     ${BASE_ADDRESSES.WETH}`);
  console.log(`  [INFO] NOTE: minProfit is now per-call, not in constructor.`);

  const IronShield = await ethers.getContractFactory("IronShieldExecutor");

  console.log(`  [INFO] Sending deployment transaction...`);

  const contract = await IronShield.deploy(
    BASE_ADDRESSES.AAVE_V3_POOL,
    BASE_ADDRESSES.WETH
  );

  // Log the deployment transaction hash immediately (before mining)
  const deployTx = contract.deploymentTransaction();
  if (deployTx) {
    console.log(`  [TX]   Hash: ${deployTx.hash}`);
    console.log(`  [INFO] Waiting for confirmation...`);
  }

  // Wait for the contract to be deployed (mined)
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  // ── Step 5: Post-Deployment Analysis ──────────────────────────
  const endBalance = await ethers.provider.getBalance(deployer.address);
  const deploymentCost = startBalance - endBalance;

  // Get deployment receipt for gas analysis
  let gasUsed = 0n;
  if (deployTx?.hash) {
    const receipt = await ethers.provider.getTransactionReceipt(deployTx.hash);
    if (receipt) {
      gasUsed = receipt.gasUsed;
    }
  }

  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │         ✅ DEPLOYMENT SUCCESSFUL             │`);
  console.log(`  ├─────────────────────────────────────────────┤`);
  console.log(`  │  Contract:   ${contractAddress}  │`);
  console.log(`  │  Gas Used:   ${gasUsed.toString().padStart(30)} │`);
  console.log(`  │  Cost (ETH): ${ethers.formatEther(deploymentCost).padStart(30)} │`);
  console.log(`  │  End Balance:${ethers.formatEther(endBalance).padStart(30)} ETH │`);
  console.log(`  └─────────────────────────────────────────────┘`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`  [INFO] Deployment completed in ${elapsed}s`);

  // ── Step 6: Post-Deployment Instructions ──────────────────────
  console.log(`\n  ── NEXT STEPS ────────────────────────────────`);
  console.log(`  1. Add to .env:`);
  console.log(`     EXECUTOR_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(``);
  console.log(`  2. Verify on BaseScan:`);
  console.log(
    `     npx hardhat verify --network base ${contractAddress} ` +
    `${BASE_ADDRESSES.AAVE_V3_POOL} ${BASE_ADDRESSES.WETH} ${MIN_PROFIT_USDC_WEI}`
  );
  console.log(``);
  console.log(`  3. Fund the contract with initial USDC for flash loan premiums.`);
  console.log(`\n`);
}

main().catch((error: unknown) => {
  console.error(`\n  [FATAL] Deployment failed:`);
  if (error instanceof Error) {
    console.error(`  ${error.message}`);
  }
  console.error(error);
  process.exitCode = 1;
});
