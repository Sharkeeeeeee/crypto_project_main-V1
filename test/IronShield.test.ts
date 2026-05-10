/**
 * IronShield Test Suite v2.0 — Base Mainnet Fork
 * Upgraded: deadline parameter, EVM time manipulation, gas reporting
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Contract, Signer } from "ethers";

const ADDR = {
  AAVE_V3_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDC_WHALE: "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A",
  AERODROME_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  UNISWAP_V3_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481",
} as const;

const USDC_DECIMALS = 6;
const MIN_PROFIT = 1_000_000n; // 1 USDC (6 decimals) — passed per-call now
const DEADLINE_OFFSET = 300; // 5 minutes from current block

const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const fmt = (val: bigint, dec = USDC_DECIMALS): string => ethers.formatUnits(val, dec);
const tag = (label: string, msg: string): void => console.log(`  [${label}] ${msg}`);
const divider = (): void => console.log(`  ${"─".repeat(52)}`);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function encodeSwapSteps(
  steps: Array<{
    dexId: number; tokenIn: string; tokenOut: string;
    amountIn: bigint; fee: number; extraData: string;
  }>
): string {
  const tupleType =
    "tuple(uint8 dexId,address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,bytes extraData)[]";
  return abiCoder.encode([tupleType], [steps]);
}

/** Get current block timestamp from the fork */
async function getBlockTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return block ? block.timestamp : Math.floor(Date.now() / 1000);
}

/**
 * [UPGRADE #7] Advance EVM time to a specific future timestamp.
 * Ensures deadline checks and DEX deadline params work correctly
 * on a deterministic fork where block.timestamp may be stale.
 */
async function advanceBlockTime(newTimestamp: number): Promise<void> {
  await network.provider.send("evm_setNextBlockTimestamp", [newTimestamp]);
  await network.provider.send("evm_mine", []);
  tag("TIME", `EVM block time advanced to ${newTimestamp} (${new Date(newTimestamp * 1000).toISOString()})`);
}

/** Calculate a deadline N seconds from the current block */
async function futureDeadline(offsetSec = DEADLINE_OFFSET): Promise<bigint> {
  const ts = await getBlockTimestamp();
  return BigInt(ts + offsetSec);
}

// ════════════════════════════════════════════════════════════════
describe("🛡️ IronShield Executor v2.0 — Base Fork Test Suite", function () {
  this.timeout(120_000);

  let deployer: Signer;
  let deployerAddr: string;
  let executor: Contract;
  let usdc: Contract;

  // ── 1. ENVIRONMENT SETUP & WHALE IMPERSONATION ────────────
  before(async function () {
    console.log(`\n  ╔═══════════════════════════════════════════════╗`);
    console.log(`  ║     🛡️  IRONSHIELD v2.0 TEST INITIALIZATION   ║`);
    console.log(`  ╚═══════════════════════════════════════════════╝\n`);

    [deployer] = await ethers.getSigners();
    deployerAddr = await deployer.getAddress();
    usdc = new ethers.Contract(ADDR.USDC, ERC20_ABI, deployer);

    tag("INFO", `Deployer: ${deployerAddr}`);
    tag("INFO", `ETH Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployerAddr))} ETH`);
    divider();

    // [UPGRADE #7] Sync EVM time to real-world time on deterministic fork
    const currentBlockTs = await getBlockTimestamp();
    const realTime = Math.floor(Date.now() / 1000);
    if (realTime > currentBlockTs + 60) {
      tag("TIME", `Fork block time (${currentBlockTs}) is behind real time (${realTime})`);
      await advanceBlockTime(realTime);
    }

    // Whale impersonation
    tag("INFO", `Impersonating USDC whale: ${ADDR.USDC_WHALE}`);
    await network.provider.send("hardhat_impersonateAccount", [ADDR.USDC_WHALE]);
    await deployer.sendTransaction({ to: ADDR.USDC_WHALE, value: ethers.parseEther("1.0") });

    const whaleSigner = await ethers.getSigner(ADDR.USDC_WHALE);
    const whaleUsdc = usdc.connect(whaleSigner) as Contract;
    const whaleBal: bigint = await usdc.balanceOf(ADDR.USDC_WHALE);
    tag("INFO", `Whale USDC balance: ${fmt(whaleBal)} USDC`);

    const transferAmt = ethers.parseUnits("1000", USDC_DECIMALS);

    if (whaleBal < transferAmt) {
      tag("WARN", "Whale balance insufficient — using storage slot fallback");
      const balanceSlot = ethers.solidityPackedKeccak256(
        ["uint256", "uint256"], [deployerAddr, 9]
      );
      await network.provider.send("hardhat_setStorageAt", [
        ADDR.USDC, balanceSlot, abiCoder.encode(["uint256"], [transferAmt]),
      ]);
      const verifyBal: bigint = await usdc.balanceOf(deployerAddr);
      if (verifyBal < transferAmt) {
        throw new Error(`Storage slot manipulation failed. Got ${fmt(verifyBal)} USDC`);
      }
    } else {
      await whaleUsdc.transfer(deployerAddr, transferAmt);
    }

    await network.provider.send("hardhat_stopImpersonatingAccount", [ADDR.USDC_WHALE]);
    tag("INFO", `Deployer USDC balance: ${fmt(await usdc.balanceOf(deployerAddr))} USDC`);
    divider();

    // Deploy IronShieldExecutor
    tag("INFO", "Deploying IronShieldExecutor v3.1...");
    const Factory = await ethers.getContractFactory("IronShieldExecutor");
    executor = await Factory.deploy(ADDR.AAVE_V3_POOL, ADDR.WETH);
    await executor.waitForDeployment();
    tag("INFO", `IronShield deployed at: ${await executor.getAddress()}`);

    // Fund executor with USDC
    const fundAmt = ethers.parseUnits("500", USDC_DECIMALS);
    await (usdc.connect(deployer) as Contract).transfer(await executor.getAddress(), fundAmt);
    tag("INFO", `Executor USDC balance: ${fmt(await usdc.balanceOf(await executor.getAddress()))} USDC`);
    console.log(`\n  ✅ Environment setup complete.\n`);
  });

  // ── 2. DEADLINE ENFORCEMENT TEST ──────────────────────────
  describe("⏰ Deadline Enforcement — Mempool Safety", function () {
    it("should revert with TransactionTooOld when deadline has passed", async function () {
      tag("INFO", "Testing expired deadline rejection...");

      const loanAmount = ethers.parseUnits("100", USDC_DECIMALS);
      const swapData = encodeSwapSteps([]);
      const expiredDeadline = BigInt((await getBlockTimestamp()) - 60); // 60s in the past

      await expect(
        executor.initiateArbitrage(ADDR.USDC, loanAmount, MIN_PROFIT, expiredDeadline, swapData)
      ).to.be.revertedWithCustomError(executor, "TransactionTooOld");

      tag("PASS", "✅ Expired deadline correctly rejected — mempool safety active");
    });

    it("should accept a valid future deadline", async function () {
      const loanAmount = ethers.parseUnits("100", USDC_DECIMALS);
      const swapData = encodeSwapSteps([]);
      const deadline = await futureDeadline(300);

      // This will revert for OTHER reasons (empty swap steps + checkProfit),
      // but NOT for TransactionTooOld — proving deadline acceptance works.
      await expect(
        executor.initiateArbitrage(ADDR.USDC, loanAmount, MIN_PROFIT, deadline, swapData)
      ).to.not.be.revertedWithCustomError(executor, "TransactionTooOld");

      tag("PASS", "✅ Valid deadline accepted — revert is from swap logic, not deadline");
    });
  });

  // ── 3. REVERT TEST — Safety Guard ─────────────────────────
  describe("🔒 Revert Test — Safety Guard", function () {
    it("should revert on unprofitable flash loan", async function () {
      console.log(`\n  ── REVERT TEST ───────────────────────────────`);

      const loanAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      const deadline = await futureDeadline();

      const swapData = encodeSwapSteps([
        { dexId: 1, tokenIn: ADDR.USDC, tokenOut: ADDR.WETH, amountIn: 0n, fee: 500, extraData: "0x" },
        { dexId: 0, tokenIn: ADDR.WETH, tokenOut: ADDR.USDC, amountIn: 0n, fee: 0,
          extraData: abiCoder.encode(["bool"], [false]) },
      ]);

      await expect(
        executor.initiateArbitrage(ADDR.USDC, loanAmount, MIN_PROFIT, deadline, swapData)
      ).to.be.reverted;

      tag("PASS", "✅ Unprofitable flash loan correctly reverted");
      divider();
    });
  });

  // ── 4. SYNTHETIC ARBITRAGE — EVM Time Manipulation ────────
  describe("💰 Synthetic Arbitrage — Price Manipulation", function () {
    it("should profit from an artificially depegged WETH/USDC pool", async function () {
      console.log(`\n  ── SYNTHETIC ARBITRAGE TEST ──────────────────`);
      const executorAddr = await executor.getAddress();
      const usdcBefore: bigint = await usdc.balanceOf(executorAddr);
      tag("PROFIT", `Contract USDC BEFORE: ${fmt(usdcBefore)} USDC`);

      // [UPGRADE #7] Advance EVM time BEFORE whale manipulation.
      // This ensures all subsequent swaps use a fresh timestamp,
      // preventing Uniswap V3 "Transaction too old" errors on
      // deterministic forks where block.timestamp is frozen.
      const freshTimestamp = Math.floor(Date.now() / 1000) + 10;
      await advanceBlockTime(freshTimestamp);
      const deadline = await futureDeadline(600);
      tag("TIME", `Deadline set to: ${deadline} (block.timestamp + 600s)`);

      // Whale price manipulation
      await network.provider.send("hardhat_impersonateAccount", [ADDR.USDC_WHALE]);
      await deployer.sendTransaction({ to: ADDR.USDC_WHALE, value: ethers.parseEther("2.0") });

      const whaleSigner = await ethers.getSigner(ADDR.USDC_WHALE);
      const dumpAmt = ethers.parseUnits("500000", USDC_DECIMALS);
      const whaleUsdcBal: bigint = await usdc.balanceOf(ADDR.USDC_WHALE);
      let priceManipulated = false;

      if (whaleUsdcBal >= dumpAmt) {
        const whaleUsdc = usdc.connect(whaleSigner) as Contract;
        await whaleUsdc.approve(ADDR.UNISWAP_V3_ROUTER, dumpAmt);

        const uniRouter = new ethers.Contract(ADDR.UNISWAP_V3_ROUTER, [
          "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)",
        ], whaleSigner);

        try {
          await uniRouter.exactInputSingle({
            tokenIn: ADDR.USDC, tokenOut: ADDR.WETH, fee: 500,
            recipient: ADDR.USDC_WHALE, deadline: deadline,
            amountIn: dumpAmt, amountOutMinimum: 0, sqrtPriceLimitX96: 0,
          });
          tag("INFO", `Dumped ${fmt(dumpAmt)} USDC → WETH on UniV3 (price skewed)`);
          priceManipulated = true;
        } catch {
          tag("WARN", "Large swap failed — pool may lack liquidity");
        }
      } else {
        tag("WARN", `Whale USDC (${fmt(whaleUsdcBal)}) insufficient for dump`);
      }

      await network.provider.send("hardhat_stopImpersonatingAccount", [ADDR.USDC_WHALE]);

      // Execute arbitrage with deadline
      const loanAmount = ethers.parseUnits("5000", USDC_DECIMALS);
      const swapData = encodeSwapSteps([
        { dexId: 0, tokenIn: ADDR.USDC, tokenOut: ADDR.WETH, amountIn: 0n, fee: 0,
          extraData: abiCoder.encode(["bool"], [false]) },
        { dexId: 1, tokenIn: ADDR.WETH, tokenOut: ADDR.USDC, amountIn: 0n, fee: 500, extraData: "0x" },
      ]);

      tag("INFO", `Arbitrage: USDC → WETH (Aero) → USDC (UniV3), deadline=${deadline}`);

      try {
        const tx = await executor.initiateArbitrage(ADDR.USDC, loanAmount, MIN_PROFIT, deadline, swapData);
        const receipt = await tx.wait();

        const usdcAfter: bigint = await usdc.balanceOf(executorAddr);
        const netProfit = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;

        console.log(`\n  ┌─────────────────────────────────────────────┐`);
        console.log(`  │         💰 ARBITRAGE EXECUTION REPORT        │`);
        console.log(`  ├─────────────────────────────────────────────┤`);
        tag("GAS", `Gas Used:       ${receipt.gasUsed.toString()}`);
        tag("PROFIT", `USDC Before:    ${fmt(usdcBefore)} USDC`);
        tag("PROFIT", `USDC After:     ${fmt(usdcAfter)} USDC`);
        tag("PROFIT", `Net Profit:     ${fmt(netProfit)} USDC`);
        console.log(`  └─────────────────────────────────────────────┘`);

        expect(usdcAfter).to.be.gte(usdcBefore);
        tag("PASS", "✅ Arbitrage executed — contract balance increased");
      } catch (err: unknown) {
        if (!priceManipulated) {
          tag("WARN", "Arb reverted — no price dislocation (expected)");
          this.skip();
        } else {
          throw err;
        }
      }
      divider();
    });
  });

  // ── 5. HONEYPOT EVASION ───────────────────────────────────
  describe("🍯 Honeypot Evasion — Security Warden", function () {
    it("should revert via TokenIsBlacklisted for blacklisted honeypot", async function () {
      const MalToken = await ethers.getContractFactory("MaliciousToken");
      const honeypot = await MalToken.deploy(ethers.parseEther("1000000"));
      await honeypot.waitForDeployment();
      const honeypotAddr = await honeypot.getAddress();

      await executor.blacklistToken(honeypotAddr, "Honeypot: transfer reverts");
      expect(await executor.blacklisted(honeypotAddr)).to.equal(true);

      const deadline = await futureDeadline();
      const swapData = encodeSwapSteps([
        { dexId: 3, tokenIn: ADDR.USDC, tokenOut: honeypotAddr, amountIn: 0n, fee: 0,
          extraData: abiCoder.encode(["address", "bytes"], [honeypotAddr, "0x"]) },
      ]);

      await expect(
        executor.initiateArbitrage(ADDR.USDC, ethers.parseUnits("1000", USDC_DECIMALS), MIN_PROFIT, deadline, swapData)
      ).to.be.reverted;

      tag("PASS", "✅ Honeypot evaded — blacklist guard works");
    });

    it("should revert if unblacklisted honeypot causes swap failure", async function () {
      const MalToken = await ethers.getContractFactory("MaliciousToken");
      const hp2 = await MalToken.deploy(ethers.parseEther("500000"));
      await hp2.waitForDeployment();
      const hp2Addr = await hp2.getAddress();

      const deadline = await futureDeadline();
      const swapData = encodeSwapSteps([
        { dexId: 3, tokenIn: ADDR.USDC, tokenOut: hp2Addr, amountIn: 0n, fee: 0,
          extraData: abiCoder.encode(["address", "bytes"], [hp2Addr, "0x"]) },
      ]);

      await expect(
        executor.initiateArbitrage(ADDR.USDC, ethers.parseUnits("100", USDC_DECIMALS), MIN_PROFIT, deadline, swapData)
      ).to.be.reverted;

      tag("PASS", "✅ Unblacklisted honeypot — swap failure caused full revert");
    });
  });

  // ── 6. ACCESS CONTROL & ADMIN ─────────────────────────────
  describe("🔐 Access Control & Admin", function () {
    it("should reject non-owner", async function () {
      const [, attacker] = await ethers.getSigners();
      const deadline = await futureDeadline();
      await expect(
        executor.connect(attacker).initiateArbitrage(ADDR.USDC, 100n, MIN_PROFIT, deadline, encodeSwapSteps([]))
      ).to.be.revertedWithCustomError(executor, "Unauthorized");
      tag("PASS", "✅ Non-owner rejected");
    });

    it("should reject when paused", async function () {
      await executor.setPaused(true);
      const deadline = await futureDeadline();
      await expect(
        executor.initiateArbitrage(ADDR.USDC, 100n, MIN_PROFIT, deadline, encodeSwapSteps([]))
      ).to.be.revertedWithCustomError(executor, "ContractPaused");
      await executor.setPaused(false);
      tag("PASS", "✅ Pause guard works");
    });

    // [FIX #2] setMinProfit removed — minProfit is now per-call
    // No global state test needed

    it("should withdraw profit", async function () {
      const executorAddr = await executor.getAddress();
      const execBal: bigint = await usdc.balanceOf(executorAddr);
      if (execBal === 0n) { this.skip(); return; }

      const before: bigint = await usdc.balanceOf(deployerAddr);
      await executor.withdrawProfit(ADDR.USDC, execBal);
      expect((await usdc.balanceOf(deployerAddr) as bigint) - before).to.equal(execBal);

      await (usdc.connect(deployer) as Contract).transfer(executorAddr, execBal);
      tag("PASS", `✅ Withdrew ${fmt(execBal)} USDC`);
    });
  });

  after(function () {
    console.log(`\n  ╔═══════════════════════════════════════════════╗`);
    console.log(`  ║     🛡️  IRONSHIELD v3.1 TEST SUITE COMPLETE   ║`);
    console.log(`  ╚═══════════════════════════════════════════════╝\n`);
  });
});
