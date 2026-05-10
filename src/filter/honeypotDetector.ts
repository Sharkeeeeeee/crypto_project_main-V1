/**
 * IronShield Honeypot Detector (The Filter - Module 1c)
 * Dynamic buy-sell simulation on local fork
 * Detects hidden taxes, failed sells, and abnormal slippage
 */
import { ethers, Contract } from "ethers";
import { createModuleLogger } from "../utils/logger";
import { ADDRESSES } from "../config/config";

const log = createModuleLogger("HONEYPOT");

interface HoneypotResult {
  token: string;
  isHoneypot: boolean;
  buyTax: number;
  sellTax: number;
  buySuccess: boolean;
  sellSuccess: boolean;
  reason?: string;
}

export class HoneypotDetector {
  private provider: ethers.JsonRpcProvider;
  private blacklist: Set<string> = new Set();

  constructor(provider: ethers.JsonRpcProvider) {
    this.provider = provider;
  }

  /**
   * Simulate buy → immediate sell on local fork
   * Detects honeypots by measuring actual vs expected output
   */
  async detectHoneypot(
    tokenAddress: string,
    dexRouter: string,
    amountInWei: bigint = ethers.parseEther("0.1")
  ): Promise<HoneypotResult> {
    if (this.blacklist.has(tokenAddress.toLowerCase())) {
      return {
        token: tokenAddress, isHoneypot: true,
        buyTax: 100, sellTax: 100,
        buySuccess: false, sellSuccess: false,
        reason: "Previously blacklisted",
      };
    }

    log.info(`🕵️ Testing honeypot: ${tokenAddress}`);

    const result: HoneypotResult = {
      token: tokenAddress, isHoneypot: false,
      buyTax: 0, sellTax: 0,
      buySuccess: false, sellSuccess: false,
    };

    try {
      // Create impersonated signer with ETH balance
      const testAddress = "0x000000000000000000000000000000000000dEaD";
      await this.provider.send("hardhat_impersonateAccount", [testAddress]);
      await this.provider.send("hardhat_setBalance", [
        testAddress,
        ethers.toQuantity(ethers.parseEther("10")),
      ]);

      const signer = await this.provider.getSigner(testAddress);
      const weth = new Contract(ADDRESSES.WETH, [
        "function deposit() payable",
        "function approve(address,uint256) returns(bool)",
        "function balanceOf(address) view returns(uint256)",
      ], signer);

      const token = new Contract(tokenAddress, [
        "function balanceOf(address) view returns(uint256)",
        "function approve(address,uint256) returns(bool)",
        "function decimals() view returns(uint8)",
      ], signer);

      const router = new Contract(dexRouter, [
        "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
        "function getAmountsOut(uint256,address[]) view returns(uint256[])",
      ], signer);

      // Step 1: Wrap ETH → WETH
      await weth.deposit({ value: amountInWei });
      await weth.approve(dexRouter, ethers.MaxUint256);

      // Step 2: Get expected buy output
      const buyPath = [ADDRESSES.WETH, tokenAddress];
      let expectedBuyOutput: bigint;
      try {
        const amounts = await router.getAmountsOut(amountInWei, buyPath);
        expectedBuyOutput = amounts[1];
      } catch {
        result.isHoneypot = true;
        result.reason = "Cannot get buy quote";
        this.permanentBlacklist(tokenAddress, result.reason);
        return result;
      }

      // Step 3: Execute buy
      const balanceBefore = await token.balanceOf(testAddress);
      try {
        await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          amountInWei, 0, buyPath, testAddress, ethers.MaxUint256
        );
        result.buySuccess = true;
      } catch {
        result.isHoneypot = true;
        result.reason = "Buy transaction reverted";
        this.permanentBlacklist(tokenAddress, result.reason);
        return result;
      }

      const balanceAfterBuy = BigInt(await token.balanceOf(testAddress));
      const actualBuyOutput = balanceAfterBuy - BigInt(balanceBefore);

      // Calculate buy tax
      if (expectedBuyOutput > 0n) {
        result.buyTax = Number(
          ((BigInt(expectedBuyOutput) - actualBuyOutput) * 10000n) / BigInt(expectedBuyOutput)
        ) / 100;
      }

      // Step 4: Attempt sell
      await token.approve(dexRouter, ethers.MaxUint256);
      const sellPath = [tokenAddress, ADDRESSES.WETH];

      let expectedSellOutput: bigint;
      try {
        const sellAmounts = await router.getAmountsOut(actualBuyOutput, sellPath);
        expectedSellOutput = sellAmounts[1];
      } catch {
        result.isHoneypot = true;
        result.reason = "Cannot get sell quote";
        this.permanentBlacklist(tokenAddress, result.reason);
        return result;
      }

      const wethBefore = await weth.balanceOf(testAddress);
      try {
        await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          actualBuyOutput, 0, sellPath, testAddress, ethers.MaxUint256
        );
        result.sellSuccess = true;
      } catch {
        result.isHoneypot = true;
        result.reason = "Sell transaction reverted - CONFIRMED HONEYPOT";
        this.permanentBlacklist(tokenAddress, result.reason);
        return result;
      }

      const wethAfterSell = BigInt(await weth.balanceOf(testAddress));
      const actualSellOutput = wethAfterSell - BigInt(wethBefore);

      // Calculate sell tax
      if (expectedSellOutput > 0n) {
        result.sellTax = Number(
          ((BigInt(expectedSellOutput) - actualSellOutput) * 10000n) / BigInt(expectedSellOutput)
        ) / 100;
      }

      // Flag as honeypot if taxes are abnormal (>10%)
      if (result.buyTax > 10 || result.sellTax > 10) {
        result.isHoneypot = true;
        result.reason = `High tax detected: Buy=${result.buyTax}%, Sell=${result.sellTax}%`;
        this.permanentBlacklist(tokenAddress, result.reason);
      }

      // Stop impersonation
      await this.provider.send("hardhat_stopImpersonatingAccount", [testAddress]);

      log.info(
        `${result.isHoneypot ? "🚨" : "✅"} Token ${tokenAddress}: ` +
        `Buy=${result.buySuccess}, Sell=${result.sellSuccess}, ` +
        `BuyTax=${result.buyTax}%, SellTax=${result.sellTax}%`
      );
    } catch (error: any) {
      log.error(`Honeypot detection failed: ${error.message}`);
      result.isHoneypot = true;
      result.reason = `Detection error: ${error.message}`;
    }

    return result;
  }

  private permanentBlacklist(token: string, reason: string): void {
    this.blacklist.add(token.toLowerCase());
    log.warn(`🚫 BLACKLISTED: ${token} — ${reason}`);
  }

  isBlacklisted(token: string): boolean {
    return this.blacklist.has(token.toLowerCase());
  }

  getBlacklist(): string[] {
    return [...this.blacklist];
  }
}
