/**
 * IronShield Token Auditor (The Filter - Module 1b)
 * Static code analysis for honeypot detection
 */
import axios from "axios";
import { createModuleLogger } from "../utils/logger";

const log = createModuleLogger("AUDITOR");

interface AuditIssue {
  name: string;
  severity: string;
  description: string;
}

export interface AuditResult {
  token: string;
  isClean: boolean;
  issues: AuditIssue[];
  riskScore: number;
  sourceVerified: boolean;
  isProxy: boolean;
}

const PATTERNS: { name: string; regex: RegExp; severity: string }[] = [
  { name: "Transfer Tax", regex: /(?:sell|buy|transfer)(?:Tax|Fee|Rate)\s*=/i, severity: "HIGH" },
  { name: "Owner Trading Switch", regex: /function\s+(?:enableTrading|openTrading)\s*\(\s*\)\s*(?:external|public)\s+onlyOwner/i, severity: "CRITICAL" },
  { name: "Blacklist", regex: /mapping\s*\(\s*address\s*=>\s*bool\s*\)\s*(?:public|private|internal)\s+(?:blacklisted|_blacklist|isBot)/i, severity: "HIGH" },
  { name: "Proxy/Delegatecall", regex: /delegatecall\s*\(/i, severity: "CRITICAL" },
  { name: "Balance Manipulation", regex: /_balances\s*\[\s*sender\s*\]\s*(?:\.sub|-=)\s*\([^)]*amount\s*[+*]/i, severity: "CRITICAL" },
  { name: "Self-Destruct", regex: /selfdestruct\s*\(/i, severity: "CRITICAL" },
  { name: "Anti-Sell", regex: /if\s*\(\s*(?:to|recipient)\s*==\s*(?:uniswapV2Pair|pair)\s*\)\s*\{[^}]*revert/i, severity: "CRITICAL" },
  { name: "Max TX Limit", regex: /require\s*\(\s*amount\s*<=\s*(?:_maxTxAmount|maxTransaction)/i, severity: "MEDIUM" },
];

export class TokenAuditor {
  private basescanApiKey: string;
  private cache: Map<string, AuditResult> = new Map();

  constructor(basescanApiKey: string) {
    this.basescanApiKey = basescanApiKey;
  }

  async auditToken(tokenAddress: string, depth: number = 0): Promise<AuditResult> {
    const cached = this.cache.get(tokenAddress.toLowerCase());
    if (cached) return cached;

    if (depth > 2) {
      log.warn(`⚠️ Maximum audit depth reached for ${tokenAddress}`);
      return {
        token: tokenAddress, isClean: false, issues: [{ name: "Too Deep", severity: "HIGH", description: "Proxy recursion depth exceeded" }],
        riskScore: 50, sourceVerified: true, isProxy: true,
      };
    }

    log.info(`🔬 Auditing token: ${tokenAddress} (depth: ${depth})`);

    const result: AuditResult = {
      token: tokenAddress, isClean: true, issues: [],
      riskScore: 0, sourceVerified: false, isProxy: false,
    };

    try {
      const sourceData = await this.fetchSourceData(tokenAddress);
      if (!sourceData || !sourceData.SourceCode) {
        result.isClean = false;
        result.riskScore = 100;
        result.issues.push({ name: "Unverified", severity: "CRITICAL", description: "Source not verified on BaseScan" });
        this.cache.set(tokenAddress.toLowerCase(), result);
        return result;
      }

      result.sourceVerified = true;
      
      // [Optimization] Handle Proxy Contracts: Audit the implementation instead
      if (sourceData.Proxy === "1" && sourceData.Implementation) {
        log.info(`🔗 Proxy detected, auditing implementation: ${sourceData.Implementation}`);
        result.isProxy = true;
        const implResult = await this.auditToken(sourceData.Implementation, depth + 1);
        const finalResult = { ...implResult, token: tokenAddress };
        this.cache.set(tokenAddress.toLowerCase(), finalResult);
        return finalResult;
      }

      const sourceCode = this.extractSourceText(sourceData.SourceCode);

      for (const p of PATTERNS) {
        if (p.regex.test(sourceCode)) {
          result.issues.push({ name: p.name, severity: p.severity, description: `Detected: ${p.name}` });
          result.riskScore += p.severity === "CRITICAL" ? 30 : p.severity === "HIGH" ? 20 : 10;
        }
      }

      result.isClean = result.riskScore < 20;
      result.riskScore = Math.min(result.riskScore, 100);
      log.info(`${result.isClean ? "✅" : "⚠️"} Risk=${result.riskScore}, Issues=${result.issues.length}`);
    } catch (error: any) {
      log.error(`Audit failed: ${error.message}`);
      result.riskScore = 80;
      result.isClean = false;
    }

    this.cache.set(tokenAddress.toLowerCase(), result);
    return result;
  }

  private async fetchSourceData(address: string): Promise<any | null> {
    try {
      const url = `https://api.basescan.org/api?module=contract&action=getsourcecode&address=${address}&apikey=${this.basescanApiKey}`;
      const response = await axios.get(url, { timeout: 10000 });
      if (response.data.status === "1" && response.data.result && response.data.result[0]) {
        return response.data.result[0];
      }
      return null;
    } catch { return null; }
  }

  private extractSourceText(sourceCode: string): string {
    // BaseScan often returns JSON for multi-file contracts
    if (sourceCode.startsWith("{{") && sourceCode.endsWith("}}")) {
      try {
        const jsonStr = sourceCode.slice(1, -1);
        const data = JSON.parse(jsonStr);
        if (data.sources) {
          return Object.values(data.sources)
            .map((s: any) => s.content || "")
            .join("\n");
        }
      } catch (e) {
        log.debug("Failed to parse SourceCode JSON, using raw string");
      }
    }
    return sourceCode;
  }

  async isTokenSafe(tokenAddress: string): Promise<boolean> {
    const audit = await this.auditToken(tokenAddress);
    return audit.isClean;
  }
}
