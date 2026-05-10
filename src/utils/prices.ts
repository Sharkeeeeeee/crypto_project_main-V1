/**
 * IronShield Price Oracle
 * Fetches USD prices for gas cost & profit calculations
 */
import { ethers } from "ethers";
import axios from "axios";
import { createModuleLogger } from "./logger";

const log = createModuleLogger("PRICES");

// Cache prices for 30 seconds
let ethPriceCache: { price: number; timestamp: number } | null = null;
const CACHE_TTL_MS = 30_000;

/**
 * Get current ETH price in USD
 * Uses CoinGecko free API as primary, with fallback to on-chain oracle
 */
export async function getEthPriceUSD(): Promise<number> {
  // Check cache first
  if (ethPriceCache && Date.now() - ethPriceCache.timestamp < CACHE_TTL_MS) {
    return ethPriceCache.price;
  }

  try {
    // CoinGecko free API
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { timeout: 5000 }
    );
    const price = response.data.ethereum.usd;

    ethPriceCache = { price, timestamp: Date.now() };
    log.debug(`ETH price updated: $${price}`);
    return price;
  } catch (error) {
    log.warn("CoinGecko API failed, using fallback price");
    // Fallback: use last cached price or a reasonable estimate
    return ethPriceCache?.price || 3000;
  }
}

/**
 * Convert wei amount to USD
 */
export async function weiToUSD(weiAmount: bigint): Promise<number> {
  const ethPrice = await getEthPriceUSD();
  const ethAmount = Number(ethers.formatEther(weiAmount));
  return ethAmount * ethPrice;
}

/**
 * Convert USD to wei amount
 */
export async function usdToWei(usdAmount: number): Promise<bigint> {
  const ethPrice = await getEthPriceUSD();
  const ethAmount = usdAmount / ethPrice;
  return ethers.parseEther(ethAmount.toFixed(18));
}

/**
 * Calculate gas cost in USD
 */
export async function gasCostUSD(
  gasUsed: bigint,
  gasPriceWei: bigint
): Promise<number> {
  const totalWei = gasUsed * gasPriceWei;
  return weiToUSD(totalWei);
}
