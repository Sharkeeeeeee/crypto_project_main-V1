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
  BASESWAP_FACTORY: "0xFDA619b6d20975be89A1033f03F704621ad70775",

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
    "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO (Correct)
    "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", // VIRTUAL (Correct)
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
    "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", // DEGEN (Correct)
    "0x532f27101965dd16442e59d40670faf5ebb142e4", // BRETT (Correct)
    "0xAC1Bd2465aA515910006945042443b961c7c0146", // TOSHI
    "0x05767d9Ef41Dc40689678fFca0608878fb3dE906", // HIGHER
    "0x9D092780e037f6aB5812B7D034346899E054e04f", // KEYCAT
  ],
} as const;

// ── Execution Parameters ─────────────────────────────────────
export const EXECUTION = {
  MIN_PROFIT_USD: parseFloat(process.env.MIN_PROFIT_USD || "2.0"),
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
  SCAN_INTERVAL_MS: parseInt(process.env.SCAN_INTERVAL_MS || "3000"),
  MIN_SPREAD_PCT: 0.1,
  MIN_MARKET_CAP: parseFloat(process.env.MIN_MARKET_CAP || "20000"),
  MAX_MARKET_CAP: parseFloat(process.env.MAX_MARKET_CAP || "200000"),
  MIN_LIQUIDITY_USD: 5000,
  MIN_CONTRACT_AGE_HOURS: 48,
  MAX_CONCURRENT_SIMULATIONS: 5,
  // [v3.1] Maximum pools to query in a single concurrent batch.
  // Prevents RPS spikes when scanning multiple DEX pools.
  POOL_SCAN_CHUNK_SIZE: parseInt(process.env.POOL_SCAN_CHUNK_SIZE || "10"),
  // [v3.1] Jitter delay (ms) between firing requests in a batch.
  POOL_SCAN_JITTER_MS: parseInt(process.env.POOL_SCAN_JITTER_MS || "100"),
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

export interface PoolInfo {
  address: string;
  dexId: DexId;
  token0: string;
  token1: string;
  tokenA: string;
  tokenB: string;
  reserve0: bigint;
  reserve1: bigint;
  fee: number;
  stable?: boolean;
  price: number;
  liquidityUSD: number;
  extraData?: string;
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
