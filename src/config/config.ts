/**
 * IronShield Configuration Module
 * Centralized configuration for all system parameters
 */
import * as dotenv from "dotenv";
dotenv.config();

// ── Base Chain Contract Addresses ────────────────────────────
export const ADDRESSES = {
  // DEX Routers
  AERODROME_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  UNISWAP_V3_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481",
  UNISWAP_UNIVERSAL_ROUTER: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  BASESWAP_ROUTER: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86",

  // Core Tokens
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",

  // Aave V3 on Base (use address book for latest)
  AAVE_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  AAVE_POOL_ADDRESSES_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",

  // Factories (for pool scanning)
  AERODROME_FACTORY: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  UNISWAP_V3_FACTORY: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",

  // ── Long-Tail Assets (Rotation Scanning) ─────────────────────
  EXTENDED_WHITELIST: [
    "0x940181a94a35a4569e4529a3cdfb74e38fd98631", // AERO (Verified)
    "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b", // VIRTUAL (Verified)
    "0x55cd6469490226466f849c06173b9e4c1247ee4", // LUNA (Verified)
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
    "0x4ed4E281567A09b113703273a3A82D853a779dfA", // DEGEN (Verified)
    "0x532f27101965dd16442e59d40670faf5ebb142e4", // BRETT (Verified)
    "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4", // TOSHI (Verified)
    "0x0557a26f63435c5c0d54024765666f7f6f5926ec", // HIGHER (Verified)
    "0x9a26f543e0d046c438c82300b95755102d2817973", // KEYCAT (Verified)
    "0xA88594D404727625A9437c3f886C7643872296aE", // WELL (Verified)
    "0x2416092f143378750bb29b79ed961ab195cceea5", // ezETH (Verified)
  ],
} as const;

// ── Execution Parameters ─────────────────────────────────────
export const EXECUTION = {
  MIN_PROFIT_USD: parseFloat(process.env.MIN_PROFIT_USD || "1.50"),
  MAX_GAS_PRICE_GWEI: parseFloat(process.env.MAX_GAS_PRICE_GWEI || "5"),
  DEFAULT_LOAN_AMOUNT: BigInt(process.env.DEFAULT_LOAN_AMOUNT || "1000000000000000000"),
  GAS_BUFFER_MULTIPLIER: 1.2,
  MAX_SLIPPAGE_PCT: 0.5,
  SIMULATION_ITERATIONS: parseInt(process.env.SIMULATION_ITERATIONS || "1000"),
} as const;

// ── Scanner Parameters ───────────────────────────────────────
export const SCANNER = {
  // [v3.1] Block-aligned: Base produces blocks every 2s.
  // Polling faster wastes QuickNode API credits for zero benefit.
  SCAN_INTERVAL_MS: parseInt(process.env.SCAN_INTERVAL_MS || "2000"),
  MIN_SPREAD_PCT: parseFloat(process.env.MIN_SPREAD_PCT || "0.8"),
  MIN_MARKET_CAP: parseFloat(process.env.MIN_MARKET_CAP || "20000"),
  MAX_MARKET_CAP: parseFloat(process.env.MAX_MARKET_CAP || "200000"),
  MIN_LIQUIDITY_USD: 5000,
  MIN_CONTRACT_AGE_HOURS: 48,
  MAX_CONCURRENT_SIMULATIONS: 5,
  // [v3.1] Maximum pools to query in a single concurrent batch.
  // Prevents RPS spikes when scanning multiple DEX pools.
  POOL_SCAN_CHUNK_SIZE: parseInt(process.env.POOL_SCAN_CHUNK_SIZE || "5"),
  // [v3.1] Jitter delay (ms) between firing requests in a batch.
  POOL_SCAN_JITTER_MS: parseInt(process.env.POOL_SCAN_JITTER_MS || "50"),
} as const;

// ── RPC Configuration ────────────────────────────────────────
export const RPC = {
  PRIMARY: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  FALLBACK: process.env.BASE_RPC_FALLBACK || process.env.BASE_RPC_URL || "https://mainnet.base.org",
  CHAIN_ID: 8453,
  BLOCK_TIME_MS: 2000,
  // [v3.1] Rate limiting — QuickNode/Tatum enforces strict RPS caps
  MAX_RPS: parseInt(process.env.RPC_MAX_RPS || "10"),
  BURST_CAPACITY: parseInt(process.env.RPC_BURST_CAPACITY || "15"),
  // [v3.1] Tatum API key — injected as x-api-key header if set
  TATUM_API_KEY: process.env.TATUM_API_KEY || "",
} as const;

// ── Logging Configuration ────────────────────────────────────
export const LOGGING = {
  LEVEL: process.env.LOG_LEVEL || "info",
  DIR: process.env.LOG_DIR || "./logs",
  HOURLY_BACKUP: true,
  MAX_FILE_SIZE: "10m",
  MAX_FILES: 30,
} as const;

// ── DEX Identifiers (matches Solidity contract) ──────────────
export enum DexId {
  AERODROME = 0,
  UNISWAP_V3 = 1,
  BASESWAP = 2,
  CUSTOM = 3,
}

// ── Uniswap V3 Fee Tiers ────────────────────────────────────
export enum UniV3Fee {
  LOWEST = 100,
  LOW = 500,
  MEDIUM = 3000,
  HIGH = 10000,
}

// ── Type Definitions ─────────────────────────────────────────
export interface ArbitragePath {
  id: string;
  steps: SwapStep[];
  loanAmount: bigint; // Dynamic flash loan amount
  assetPriceUSD: number; // Price of the loan asset in USD
  estimatedProfit: bigint;
  estimatedGas: bigint;
  profitUSD: number;
  confidence: number;
  timestamp: number;
}

export interface SwapStep {
  dexId: DexId;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  fee: number;
  extraData: string;
  poolAddress?: string;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  marketCap?: number;
  isVerified: boolean;
  isBlacklisted: boolean;
  lpLocked: boolean;
  contractAge: number;
  transferTax: number;
}

export interface SimulationResult {
  path: ArbitragePath;
  success: boolean;
  outputAmount: bigint;
  gasUsed: bigint;
  netProfit: bigint;
  profitUSD: number;
  errorMessage?: string;
  executionTimeMs: number;
}

export interface ExecutionResult {
  txHash: string;
  success: boolean;
  profit: bigint;
  gasUsed: bigint;
  blockNumber: number;
  timestamp: number;
  errorMessage?: string;
}
