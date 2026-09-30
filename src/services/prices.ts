// ZeroDust Price Service - Fetches token prices from backend (CoinGecko)

// Use local proxy in development to avoid CORS issues
const API_URL = typeof window !== 'undefined' && window.location.hostname === 'localhost'
  ? '/api/proxy'
  // Production must never fall back to localhost: a build without the env var
  // sent every visitor's API calls to their own machine (audit 2026-09-30)
  : (process.env.NEXT_PUBLIC_API_URL || 'https://api.zerodust.xyz');

// Map testnet token symbols to their mainnet equivalents for price lookups (uppercase keys)
const TESTNET_TO_MAINNET: Record<string, string> = {
  'TBNB': 'BNB',    // BSC Testnet
  'MATIC': 'POL',   // Legacy Polygon symbol
};

// Get the symbol to use for price lookups
function getPriceSymbol(symbol: string): string {
  return TESTNET_TO_MAINNET[symbol] || symbol;
}

export interface TokenPrice {
  priceUsd: number;
  symbol?: string;
}

export interface PricesResponse {
  [symbol: string]: TokenPrice;
}

class PriceServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'PriceServiceError';
  }
}

// Cache prices for 10 minutes to stay within CoinGecko free tier limits
let priceCache: { data: PricesResponse | null; timestamp: number } = {
  data: null,
  timestamp: 0,
};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchPrices<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new PriceServiceError(response.status, error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

export const priceService = {
  /**
   * Get all token prices
   */
  async getAllPrices(): Promise<PricesResponse> {
    // Check cache
    const now = Date.now();
    if (priceCache.data && now - priceCache.timestamp < CACHE_TTL) {
      return priceCache.data;
    }

    const prices = await fetchPrices<PricesResponse>('/prices');

    // Update cache
    priceCache = { data: prices, timestamp: now };

    return prices;
  },

  /**
   * Get price for a specific token
   */
  async getPrice(symbol: string): Promise<TokenPrice> {
    // Map testnet symbols to mainnet for price lookup
    const priceSymbol = getPriceSymbol(symbol.toUpperCase());

    // First try from cache
    const now = Date.now();
    if (priceCache.data && now - priceCache.timestamp < CACHE_TTL) {
      const cached = priceCache.data[priceSymbol];
      if (cached) return cached;
    }

    return fetchPrices<TokenPrice>(`/prices/${priceSymbol}`);
  },

  /**
   * Get ETH price in USD
   */
  async getEthPrice(): Promise<number> {
    const price = await this.getPrice('ETH');
    return price.priceUsd;
  },

  /**
   * Clear the price cache (useful for forcing refresh)
   */
  clearCache() {
    priceCache = { data: null, timestamp: 0 };
  },
};

export { PriceServiceError };
