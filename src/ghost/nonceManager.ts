/**
 * ════════════════════════════════════════════════════════════════
 *  IronShield Nonce Manager v3.0 — Mutex Queue System
 *
 *  [UPGRADE #5] Nonce Collision Prevention
 *
 *  Problem: If the PathOptimizer finds 2 profitable paths in the same
 *  millisecond, both call getNextNonce() concurrently. Without proper
 *  synchronization, they receive the SAME nonce → one transaction gets
 *  dropped or replaces the other. In MEV, this means lost profit.
 *
 *  Solution: A proper async mutex + sequential transaction queue.
 *  - Mutex ensures only one caller can read/increment the nonce at a time.
 *  - Transaction queue serializes broadcast: if 2 paths are found
 *    simultaneously, they are queued and sent with sequential nonces.
 *  - Auto-recovery: if a nonce gap is detected (e.g., from a dropped tx),
 *    the manager re-syncs from the chain before the next send.
 * ════════════════════════════════════════════════════════════════
 */
import { ethers } from "ethers";
import { createModuleLogger } from "../utils/logger";

const log = createModuleLogger("NONCE");

// ── Async Mutex ──────────────────────────────────────────────
// A proper FIFO mutex — unlike a boolean spinlock, this uses a
// promise chain to guarantee fair ordering. Each caller awaits
// the previous caller's completion before proceeding.

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    // Queue this caller — they will be unblocked when release() is called
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      // Unblock the next waiter (FIFO order)
      const next = this.queue.shift()!;
      // Use queueMicrotask to ensure the released caller runs
      // before any new acquire() calls from the current tick
      queueMicrotask(next);
    } else {
      this.locked = false;
    }
  }
}

// ── Transaction Queue Item ───────────────────────────────────

interface QueuedTransaction {
  /** Unique ID for tracking */
  id: string;
  /** The populated transaction to send */
  txRequest: ethers.TransactionRequest;
  /** Resolve with the sent TransactionResponse */
  resolve: (value: ethers.TransactionResponse) => void;
  /** Reject on failure */
  reject: (reason: Error) => void;
  /** Timestamp when queued */
  queuedAt: number;
}

// ── Nonce Manager ────────────────────────────────────────────

export class NonceManager {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private address: string;
  private currentNonce: number = -1;
  private pendingTxCount: number = 0;

  /** Mutex for nonce read-increment atomicity */
  private nonceMutex = new AsyncMutex();

  /** Sequential transaction queue */
  private txQueue: QueuedTransaction[] = [];
  private isProcessingQueue = false;

  /** Maximum pending transactions before rejecting new ones */
  private readonly MAX_PENDING = 5;
  /** Nonce staleness threshold — re-sync if pending count exceeds this */
  private readonly RESYNC_THRESHOLD = 3;

  constructor(
    provider: ethers.JsonRpcProvider,
    address: string,
    privateKey?: string
  ) {
    this.provider = provider;
    this.address = address;
    this.wallet = privateKey
      ? new ethers.Wallet(privateKey, provider)
      : new ethers.Wallet(ethers.ZeroHash, provider); // Placeholder for read-only
  }

  /**
   * Initialize nonce from on-chain state.
   * Uses "pending" to account for in-flight transactions.
   */
  async initialize(): Promise<void> {
    await this.nonceMutex.acquire();
    try {
      this.currentNonce = await this.provider.getTransactionCount(
        this.address,
        "pending"
      );
      this.pendingTxCount = 0;
      log.info(
        `Nonce initialized: ${this.currentNonce} (from pending tx count)`
      );
    } finally {
      this.nonceMutex.release();
    }
  }

  /**
   * Get the next nonce atomically.
   *
   * The mutex guarantees that even if two async callers invoke this
   * in the same event loop tick, they receive sequential nonces.
   *
   * Auto-resync: if too many pending txs accumulate (indicating
   * possible drops), we re-query the chain for the true pending nonce.
   */
  async getNextNonce(): Promise<number> {
    await this.nonceMutex.acquire();
    try {
      // Lazy initialization
      if (this.currentNonce === -1) {
        this.currentNonce = await this.provider.getTransactionCount(
          this.address,
          "pending"
        );
      }

      // Auto-resync if we've accumulated too many unconfirmed txs
      // This catches scenarios where a tx was dropped but we kept incrementing
      if (this.pendingTxCount >= this.RESYNC_THRESHOLD) {
        log.warn(
          `⚠️  ${this.pendingTxCount} pending txs — re-syncing nonce from chain`
        );
        const chainNonce = await this.provider.getTransactionCount(
          this.address,
          "pending"
        );
        if (chainNonce > this.currentNonce) {
          // Chain has seen more txs than we thought — some were processed
          log.info(`Nonce corrected: ${this.currentNonce} → ${chainNonce}`);
          this.currentNonce = chainNonce;
          this.pendingTxCount = 0;
        }
      }

      const nonce = this.currentNonce;
      this.currentNonce++;
      this.pendingTxCount++;

      log.debug(
        `Nonce assigned: ${nonce} (local head: ${this.currentNonce}, pending: ${this.pendingTxCount})`
      );
      return nonce;
    } finally {
      this.nonceMutex.release();
    }
  }

  /**
   * Queue a transaction for sequential broadcast.
   *
   * This is the primary API for the execution engine. Instead of
   * sending transactions directly, callers queue them here.
   * The queue guarantees:
   *   1. Each tx gets a unique, sequential nonce
   *   2. Txs are sent one at a time (no race conditions)
   *   3. If a tx fails, subsequent txs are NOT corrupted
   *
   * @param txRequest Unsigned transaction (nonce will be assigned)
   * @returns The sent TransactionResponse (includes hash)
   */
  async queueTransaction(
    txRequest: ethers.TransactionRequest
  ): Promise<ethers.TransactionResponse> {
    // Backpressure: reject if too many pending
    if (this.pendingTxCount >= this.MAX_PENDING) {
      throw new Error(
        `Transaction rejected: ${this.pendingTxCount} pending txs (max: ${this.MAX_PENDING}). ` +
          `Wait for confirmations or call reset().`
      );
    }

    const id = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise<ethers.TransactionResponse>((resolve, reject) => {
      this.txQueue.push({
        id,
        txRequest,
        resolve,
        reject,
        queuedAt: Date.now(),
      });

      log.debug(`Transaction queued: ${id} (queue depth: ${this.txQueue.length})`);

      // Start processing if not already running
      this.processQueue();
    });
  }

  /**
   * Process the transaction queue sequentially.
   * Only one instance of this runs at a time (guarded by isProcessingQueue).
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    try {
      while (this.txQueue.length > 0) {
        const item = this.txQueue.shift()!;
        const waitMs = Date.now() - item.queuedAt;

        try {
          // Assign nonce atomically
          const nonce = await this.getNextNonce();

          // Merge nonce into the tx request
          const signedTxRequest: ethers.TransactionRequest = {
            ...item.txRequest,
            nonce,
          };

          log.info(
            `📤 Sending ${item.id} | nonce: ${nonce} | queue wait: ${waitMs}ms`
          );

          // Send the transaction
          const txResponse = await this.wallet.sendTransaction(signedTxRequest);

          log.info(
            `✅ Sent ${item.id} | hash: ${txResponse.hash} | nonce: ${nonce}`
          );

          item.resolve(txResponse);
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);

          // [FIX #3] CRITICAL: On ANY send failure, forcefully re-sync the nonce.
          //
          // WHY: At this point, getNextNonce() has already incremented
          // this.currentNonce (e.g., from 5 to 6). But the tx with nonce=5
          // was never broadcast (or was rejected by the RPC). The on-chain
          // pending nonce is still 5. If we don't reset, the NEXT tx will
          // use nonce=6, which is a "future transaction" — it will sit in
          // the mempool forever, and every subsequent tx will also be stuck.
          //
          // By resetting to the chain's true pending nonce, we recover from:
          //   - Insufficient funds errors
          //   - RPC connection drops
          //   - Gas estimation failures
          //   - Nonce collision / replacement errors
          //   - Any other sendTransaction failure
          log.error(
            `❌ Send failed for ${item.id}: ${errMsg.slice(0, 150)}. Re-syncing nonce...`
          );
          await this.reset();

          item.reject(
            error instanceof Error ? error : new Error(errMsg)
          );
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /** Mark a transaction as confirmed (reduce pending count) */
  confirmTransaction(): void {
    this.pendingTxCount = Math.max(0, this.pendingTxCount - 1);
    log.debug(`Transaction confirmed (pending: ${this.pendingTxCount})`);
  }

  /** Reset nonce from chain state (use after errors or stuck txs) */
  async reset(): Promise<void> {
    await this.nonceMutex.acquire();
    try {
      const oldNonce = this.currentNonce;
      this.currentNonce = await this.provider.getTransactionCount(
        this.address,
        "pending"
      );
      this.pendingTxCount = 0;
      log.info(`Nonce reset: ${oldNonce} → ${this.currentNonce}`);
    } finally {
      this.nonceMutex.release();
    }
  }

  /** Get current pending transaction count */
  getPendingCount(): number {
    return this.pendingTxCount;
  }

  /** Get current queue depth */
  getQueueDepth(): number {
    return this.txQueue.length;
  }
}
