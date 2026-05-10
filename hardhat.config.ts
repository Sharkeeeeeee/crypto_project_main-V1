import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-gas-reporter";
import * as dotenv from "dotenv";

dotenv.config();

// ── Environment Variables ───────────────────────────────────────
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x" + "0".repeat(64);
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || "";

// [v3.1] Unified RPC Resolution
// Accept PRIVATE_BASE_RPC (legacy) OR BASE_RPC_URL (preferred).
// Both point to the same private endpoint (Alchemy/QuickNode/Tatum).
// PRIVATE_BASE_RPC takes priority if both are set.
const BASE_RPC = process.env.PRIVATE_BASE_RPC || process.env.BASE_RPC_URL;

if (!BASE_RPC) {
  console.warn(
    "\n  ⚠️  [WARN] No RPC URL configured (BASE_RPC_URL or PRIVATE_BASE_RPC).\n" +
      "     Fork-based tests and mainnet deployment will fail.\n" +
      "     Set BASE_RPC_URL in your .env file.\n"
  );
}

// Tatum requires x-api-key header — inject if TATUM_API_KEY is set
const TATUM_API_KEY = process.env.TATUM_API_KEY;

// [UPGRADE #4] Deterministic fork block for reproducible tests.
// Pin to a recent Base mainnet block. Update periodically to pick up
// new liquidity pool states, but keep fixed between test runs.
const FORK_BLOCK_NUMBER = 26_800_000;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000000, // Maximum optimization for gas-critical MEV contract
      },
      viaIR: true,
      evmVersion: "cancun", // Required for EIP-1153 TSTORE/TLOAD
    },
  },
  networks: {
    hardhat: {
      forking: {
        url: BASE_RPC || "https://mainnet.base.org", // Last resort for compilation-only
        blockNumber: FORK_BLOCK_NUMBER,
        enabled: !!BASE_RPC, // Disable fork if no RPC configured
        ...(TATUM_API_KEY
          ? {
              httpHeaders: {
                "x-api-key": TATUM_API_KEY,
              },
            }
          : {}),
      },
      chainId: 8453,
      gas: "auto",
    },

    // [UPGRADE #6] EIP-1559 Dynamic Fee Configuration
    base: {
      url: BASE_RPC || "",
      chainId: 8453,
      accounts: [PRIVATE_KEY],
      ...(TATUM_API_KEY
        ? {
            httpHeaders: {
              "x-api-key": TATUM_API_KEY,
            },
          }
        : {}),
    },
  },

  // [UPGRADE #4] Gas Reporter Configuration
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    L2: "base",
    L2Etherscan: BASESCAN_API_KEY,
    // CoinMarketCap API key for USD conversion (optional)
    coinmarketcap: process.env.COINMARKETCAP_API_KEY || "",
    outputFile: process.env.GAS_REPORT_FILE || undefined,
    noColors: !!process.env.GAS_REPORT_FILE, // No ANSI colors in file output
    showTimeSpent: true,
    showMethodSig: true,
  },

  etherscan: {
    // [v3.1] Migrated to Etherscan V2 API (single key for all chains)
    apiKey: BASESCAN_API_KEY,
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
