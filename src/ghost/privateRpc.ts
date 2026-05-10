/**
 * ════════════════════════════════════════════════════════════════
 *  IronShield Private RPC Manager v3.1 — Rate-Limited Ghost Protocol
 *
 *  [v3.1 UPGRADE] QuickNode Traffic Control
 *    1. Token Bucket Rate Limiter: Enforces strict 10 RPS cap to stay
 *       under QuickNode's rate limits. All provider calls flow through
 *       a token bucket that delays requests when the budget is depleted.
 *    2. Exponential Backoff: HTTP 429 / "rate limit" errors trigger
 *       automatic retry with 500ms → 1000ms → 2000ms backoff (3 retries).
 *    3. RateLimitedProvider: Drop-in ethers.js provider wrapper that
 *       intercepts `send()` to apply throttling transparently.
 *
 *  ARCHITECTURE NOTE: Base uses a centralized sequencer (FIFO)
 *    - No Flashbots bundle support on Base
 *    - Transactions go directly to sequencer via private RPC
 *    - Frontrunning risk is inherently lower than Ethereum
 *    - Flashblocks provide 200ms pre-confirmation latency
 * ════════════════════════════════════════════════════════════════
 */
import { ethers } from "ethers";
import { createModuleLogger } from "../utils/logger";
import { RPC } from "../config/config";

const log = createModuleLogger("GHOST");

// ══════════════════════════════════════════════════════════════
//  TOKEN BUCKET RATE LIMITER
// ══════════════════════════════════════════════════════════════

/**
 * Token bucket algorithm for smooth RPS enforcement.
 *
 * How it works:
 *   - The bucket starts full with `maxTokens` tokens.
 *   - Each request consumes 1 token.
 *   - Tokens refill at `refillRate` per second.
 *   - If empty, callers wait until a token becomes available.
 *
 * Why token bucket (not sliding window):
 *   - Allows small bursts (up to `maxTokens`) while enforcing average RPS.
 *   - MEV bots need burst capacity for multi-call simulation phases,
 *     but must stay under the average limit to avoid 429s.
 */
class TokenBucketRateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefillTimestamp: number;
  private waitQueue: Array<() => void> = [];
  private processingInterval: NodeJS.Timeout;

  constructor(maxRPS: number, burstCapacity?: number) {
    this.maxTokens = burstCapacity ?? maxRPS;
    this.tokens = this.maxTokens;
    this.refillRate = maxRPS / 1000; // convert RPS to per-ms
    this.lastRefillTimestamp = Date.now();
    
    // Process queue periodically
    this.processingInterval = setInterval(() => this.processQueue(), 20);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTimestamp;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefillTimestamp = now;
  }

  private processQueue(): void {
    this.refill();
    while (this.waitQueue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const resolve = this.waitQueue.shift();
      if (resolve) resolve();
    }
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1 && this.waitQueue.length === 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
      log.debug(`⏳ RPC Queueing: bucket empty, waiting ~${waitMs}ms (Queue: ${this.waitQueue.length + 1})`);
      this.waitQueue.push(resolve);
    });
  }

  /** Current available tokens (for diagnostics) */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

// ══════════════════════════════════════════════════════════════
//  EXPONENTIAL BACKOFF RETRY
// ══════════════════════════════════════════════════════════════

/** Check if an error is a rate-limit (HTTP 429) or similar throttle error */
function isRateLimitError(error: unknown): boolean {
  if (error == null) return false;
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);

  const lower = msg.toLowerCase();

  // If the error is a normal contract execution failure, DO NOT retry
  if (
    lower.includes("execution reverted") ||
    lower.includes("revert") ||
    lower.includes("call exception")
  ) {
    return false;
  }

  // Only trigger retry for actual rate limit or timeout errors
  return (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("rate exceeded") ||
    lower.includes("quota exceeded") ||
    lower.includes("throttled") ||
    lower.includes("timeout") ||
    lower.includes("402")  // Tatum returns 402 for batch/quota issues
  );
}

/**
 * Retry a function with exponential backoff on rate-limit errors.
 *
 * @param fn        The async function to execute
 * @param maxRetries  Maximum retry attempts (default: 3)
 * @param baseDelayMs Initial delay before first retry (default: 500ms)
 * @returns The function's return value
 * @throws The last error if all retries are exhausted
 */
async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 5,
  baseDelayMs: number = 500
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      // Add a 30-second timeout to the execution
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("RPC Timeout (30s)")), 30000)
      );
      return await Promise.race([fn(), timeoutPromise]);
    } catch (error: any) {
      attempt++;
      if (attempt > maxRetries || !isRateLimitError(error)) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      const msg = error instanceof Error ? error.message : String(error);
      
      log.warn(
        `⚠️  RPC Issue (attempt ${attempt}/${maxRetries}). ` +
          `Backing off ${delay}ms. Error: ${msg.slice(0, 100)}`
      );
      
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  RATE-LIMITED PROVIDER WRAPPER
// ══════════════════════════════════════════════════════════════

/**
 * Drop-in replacement for ethers.JsonRpcProvider that wraps every
 * `send()` call with rate limiting and exponential backoff.
 *
 * All ethers.js high-level calls (getBalance, getBlock, call, etc.)
 * funnel through `send()`, so this catches everything.
 */
class RateLimitedProvider extends ethers.JsonRpcProvider {
  private rateLimiter: TokenBucketRateLimiter;
  private requestCount: number = 0;
  private throttledCount: number = 0;

  constructor(
    urlOrFetchRequest: string | ethers.FetchRequest,
    rateLimiter: TokenBucketRateLimiter
  ) {
    // ethers v6 JsonRpcProvider accepts FetchRequest for custom headers.
    // batchMaxCount=1 disables batch JSON-RPC — Tatum free tier returns
    // HTTP 402 on batch calls. staticNetwork skips the initial
    // eth_chainId probe, preventing a startup batch call failure.
    const baseNetwork = ethers.Network.from(RPC.CHAIN_ID);
    super(urlOrFetchRequest, baseNetwork, { batchMaxCount: 1, staticNetwork: baseNetwork });
    this.rateLimiter = rateLimiter;
  }

  /**
   * Override the core `send` method to inject rate limiting.
   * Every JSON-RPC call flows through here.
   */
  async send(method: string, params: Array<unknown>): Promise<unknown> {
    const start = Date.now();
    
    // Acquire a token from the bucket (may wait if depleted)
    await this.rateLimiter.acquire();
    this.requestCount++;

    // Execute with exponential backoff on 429s
    return withExponentialBackoff(async () => {
      const res = await super.send(method, params);
      const latency = Date.now() - start;
      if (latency > 1000) {
        log.warn(`🐢 Slow RPC: ${method} took ${latency}ms`);
      } else {
        log.debug(`⚡ RPC ${method} completed in ${latency}ms`);
      }
      return res;
    }).catch((error: unknown) => {
      if (isRateLimitError(error)) {
        this.throttledCount++;
        log.error(
          `🚫 Rate limit exhausted after retries: ${method} | ` +
            `Total throttled: ${this.throttledCount}`
        );
      }
      throw error;
    });
  }

  /** Diagnostics: total requests sent through this provider */
  getRequestCount(): number {
    return this.requestCount;
  }

  /** Diagnostics: total times backoff was triggered */
  getThrottledCount(): number {
    return this.throttledCount;
  }
}

// ══════════════════════════════════════════════════════════════
//  PRIVATE RPC MANAGER
// ══════════════════════════════════════════════════════════════

/** Maximum requests per second (from .env → config) */
const MAX_RPS = RPC.MAX_RPS;

/** Burst capacity (from .env → config) */
const BURST_CAPACITY = RPC.BURST_CAPACITY;

export class PrivateRpcManager {
  private rateLimiter: TokenBucketRateLimiter;
  private primaryProvider: RateLimitedProvider;
  private fallbackProvider: RateLimitedProvider;
  private activeProvider: RateLimitedProvider;
  private failoverCount: number = 0;

  constructor() {
    // Single shared rate limiter across ALL providers.
    this.rateLimiter = new TokenBucketRateLimiter(MAX_RPS, BURST_CAPACITY);

    // [v3.1] Build FetchRequest with Tatum x-api-key header if configured.
    // Without this header, Tatum returns 403 and ethers fails with
    // "failed to detect network" because the RPC rejects the request.
    const primaryReq = this.buildFetchRequest(RPC.PRIMARY);
    const fallbackReq = this.buildFetchRequest(RPC.FALLBACK);

    this.primaryProvider = new RateLimitedProvider(
      primaryReq,
      this.rateLimiter
    );
    this.fallbackProvider = new RateLimitedProvider(
      fallbackReq,
      this.rateLimiter
    );
    this.activeProvider = this.primaryProvider;

    log.info(
      `RPC Rate Limiter initialized: ${MAX_RPS} RPS sustained, ${BURST_CAPACITY} burst cap` +
        (RPC.TATUM_API_KEY ? " (Tatum auth: ✅)" : "")
    );
  }

  /**
   * Build a FetchRequest with custom headers for the RPC provider.
   * If TATUM_API_KEY is set, attaches the x-api-key header.
   * Otherwise returns the plain URL (no custom headers needed).
   */
  private buildFetchRequest(url: string): string | ethers.FetchRequest {
    // Only inject Tatum API key for Tatum endpoints
    if (!RPC.TATUM_API_KEY || !url.toLowerCase().includes("tatum")) {
      return url;
    }

    const fetchReq = new ethers.FetchRequest(url);
    fetchReq.setHeader("x-api-key", RPC.TATUM_API_KEY);
    return fetchReq;
  }

  /** Get the active rate-limited RPC provider */
  getProvider(): ethers.JsonRpcProvider {
    return this.activeProvider;
  }

  /**
   * Send a raw signed transaction via private RPC.
   * Rate-limited and auto-retried on 429.
   */
  async sendPrivateTransaction(signedTx: string): Promise<string> {
    try {
      log.info("👻 Sending private transaction to sequencer...");
      const txHash = await this.activeProvider.send(
        "eth_sendRawTransaction",
        [signedTx]
      );
      log.info(`✅ TX accepted by sequencer: ${txHash}`);
      return txHash as string;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.warn(`Primary RPC failed: ${errMsg}, trying fallback...`);

      try {
        this.activeProvider = this.fallbackProvider;
        this.failoverCount++;
        const txHash = await this.fallbackProvider.send(
          "eth_sendRawTransaction",
          [signedTx]
        );
        log.info(`✅ TX accepted via fallback: ${txHash}`);
        return txHash as string;
      } catch (fallbackError: unknown) {
        const fbMsg =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        log.error(`Both RPCs failed: ${fbMsg}`);
        throw fallbackError;
      }
    }
  }

  /**
   * Wait for transaction confirmation with timeout.
   * Leverages Flashblocks for ~200ms confirmation.
   */
  async waitForConfirmation(
    txHash: string,
    timeoutMs: number = 10000
  ): Promise<ethers.TransactionReceipt | null> {
    log.info(`⏳ Waiting for confirmation: ${txHash}`);
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const receipt =
          await this.activeProvider.getTransactionReceipt(txHash);
        if (receipt) {
          if (receipt.status === 1) {
            log.info(
              `✅ Confirmed in block #${receipt.blockNumber} (${Date.now() - startTime}ms)`
            );
          } else {
            log.error(
              `❌ Transaction reverted in block #${receipt.blockNumber}`
            );
          }
          return receipt;
        }
      } catch {
        // Receipt not available yet
      }

      // Poll every 200ms (aligned with Flashblocks)
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    log.warn(`⏰ Confirmation timeout after ${timeoutMs}ms`);
    return null;
  }

  /** Check RPC health and latency, auto-switch to fastest */
  async healthCheck(): Promise<{
    primary: { healthy: boolean; latencyMs: number };
    fallback: { healthy: boolean; latencyMs: number };
  }> {
    const checkProvider = async (
      provider: ethers.JsonRpcProvider,
      name: string
    ) => {
      const start = Date.now();
      try {
        await provider.getBlockNumber();
        const latency = Date.now() - start;
        log.debug(`${name} RPC: ${latency}ms`);
        return { healthy: true, latencyMs: latency };
      } catch {
        return { healthy: false, latencyMs: -1 };
      }
    };

    // Health checks are sequential (not concurrent) to avoid
    // burning 2 rate-limit tokens simultaneously on startup
    const primary = await checkProvider(this.primaryProvider, "Primary");
    const fallback = await checkProvider(this.fallbackProvider, "Fallback");

    if (primary.healthy && fallback.healthy) {
      this.activeProvider =
        primary.latencyMs <= fallback.latencyMs
          ? this.primaryProvider
          : this.fallbackProvider;
    } else if (primary.healthy) {
      this.activeProvider = this.primaryProvider;
    } else if (fallback.healthy) {
      this.activeProvider = this.fallbackProvider;
    }

    return { primary, fallback };
  }

  getFailoverCount(): number {
    return this.failoverCount;
  }

  /** Diagnostics: get rate limiter stats */
  getStats(): {
    availableTokens: number;
    primaryRequests: number;
    fallbackRequests: number;
    primaryThrottled: number;
    fallbackThrottled: number;
  } {
    return {
      availableTokens: this.rateLimiter.getAvailableTokens(),
      primaryRequests: this.primaryProvider.getRequestCount(),
      fallbackRequests: this.fallbackProvider.getRequestCount(),
      primaryThrottled: this.primaryProvider.getThrottledCount(),
      fallbackThrottled: this.fallbackProvider.getThrottledCount(),
    };
  }
}
