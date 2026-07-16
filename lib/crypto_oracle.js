// ── CoinMarketCap Oracle ───────────────────────────────────────────────────
// Fetches real-time price data for crypto tokens if mentioned in the market.
import fetch from 'node-fetch';

const CMC_API_KEY = process.env.CMC_API_KEY || '';
const CMC_URL = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';

export async function fetchCryptoPrices(symbols) {
  if (!CMC_API_KEY || !symbols || symbols.length === 0) return null;
  try {
    const symbolStr = symbols.join(',');
    const url = `${CMC_URL}?symbol=${symbolStr}`;
    const res = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': CMC_API_KEY,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    if (data && data.data) {
      const prices = {};
      for (const sym of symbols) {
        const coin = data.data[sym.toUpperCase()];
        if (coin && coin.quote && coin.quote.USD) {
          prices[sym.toUpperCase()] = {
            price: coin.quote.USD.price,
            percentChange24h: coin.quote.USD.percent_change_24h,
            volume24h: coin.quote.USD.volume_24h
          };
        }
      }
      return prices;
    }
    return null;
  } catch (e) {
    console.warn('[crypto_oracle] Failed to fetch CMC data:', e.message);
    return null;
  }
}

/**
 * Extracts $SYMBOLS from a text string.
 * @param {string} text
 * @returns {string[]}
 */
export function extractCryptoSymbols(text) {
  if (!text) return [];
  // Match $BTC, $ETH, but ignore plain $1000
  const regex = /\$([a-zA-Z]{2,10})\b/g;
  const symbols = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    symbols.add(match[1].toUpperCase());
  }
  return Array.from(symbols);
}
