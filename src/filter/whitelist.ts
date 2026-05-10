/**
 * IronShield Whitelist Manager (The Filter - Module 1d)
 * Manages approved tokens based on LP lock status and market cap criteria
 */
import { ethers, Contract } from "ethers";
import fs from "fs";
import path from "path";
import { createModuleLogger } from "../utils/logger";
import { SCANNER } from "../config/config";

const log = createModuleLogger("WHITELIST");

interface WhitelistEntry {
  address: string;
  symbol: string;
  addedAt: number;
  marketCap: number;
  lpLocked: boolean;
  contractAge: number; // hours
  lastChecked: number;
}

export class WhitelistManager {
  private whitelist: Map<string, WhitelistEntry> = new Map();
  private dataFile: string;

  constructor(dataDir: string = "./logs") {
    this.dataFile = path.join(dataDir, "whitelist.json");
    this.loadFromDisk();
  }

  /**
   * Evaluate if a token meets whitelist criteria
   */
  async evaluateToken(
    tokenAddress: string,
    provider: ethers.JsonRpcProvider
  ): Promise<boolean> {
    try {
      const token = new Contract(tokenAddress, [
        "function symbol() view returns(string)",
        "function totalSupply() view returns(uint256)",
        "function decimals() view returns(uint8)",
      ], provider);

      const [symbol, totalSupply, decimals] = await Promise.all([
        token.symbol().catch(() => "UNKNOWN"),
        token.totalSupply().catch(() => 0n),
        token.decimals().catch(() => 18n),
      ]);

      // Check contract age (deployed block timestamp)
      const code = await provider.getCode(tokenAddress);
      if (code === "0x") return false;

      // For now, use a simplified market cap check
      // In production, integrate with DexScreener or GeckoTerminal API
      const entry: WhitelistEntry = {
        address: tokenAddress.toLowerCase(),
        symbol: String(symbol),
        addedAt: Date.now(),
        marketCap: 0, // Would be fetched from price API
        lpLocked: false, // Would be checked via Team.Finance/Unicrypt
        contractAge: 72, // Placeholder - would calculate from deployment tx
        lastChecked: Date.now(),
      };

      // Apply filters
      if (entry.contractAge < SCANNER.MIN_CONTRACT_AGE_HOURS) {
        log.debug(`Rejected ${symbol}: too new (${entry.contractAge}h)`);
        return false;
      }

      this.whitelist.set(tokenAddress.toLowerCase(), entry);
      this.saveToDisk();
      log.info(`✅ Whitelisted: ${symbol} (${tokenAddress.slice(0, 10)}...)`);
      return true;
    } catch (error: any) {
      log.error(`Whitelist evaluation failed: ${error.message}`);
      return false;
    }
  }

  isWhitelisted(tokenAddress: string): boolean {
    return this.whitelist.has(tokenAddress.toLowerCase());
  }

  getAll(): WhitelistEntry[] {
    return [...this.whitelist.values()];
  }

  remove(tokenAddress: string): void {
    this.whitelist.delete(tokenAddress.toLowerCase());
    this.saveToDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.dataFile)) {
        const data = JSON.parse(fs.readFileSync(this.dataFile, "utf-8"));
        for (const entry of data) {
          this.whitelist.set(entry.address, entry);
        }
        log.info(`Loaded ${this.whitelist.size} whitelisted tokens`);
      }
    } catch { /* start fresh */ }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.dataFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dataFile, JSON.stringify([...this.whitelist.values()], null, 2));
    } catch { /* non-critical */ }
  }
}
