import 'dotenv/config';
import { webSearch } from './lib/agent_research.js';
import { fetchCryptoPrices, extractCryptoSymbols } from './lib/crypto_oracle.js';

async function runTests() {
  console.log('--- Testing Web Search (Tavily/Serper fallback) ---');
  try {
    const searchRes = await webSearch('Apple Inc latest news', 2);
    console.log('Provider:', searchRes.provider);
    console.log('Results count:', searchRes.results?.length);
    if (searchRes.results?.length > 0) {
      console.log('Top Result Title:', searchRes.results[0].title);
    }
  } catch (e) {
    console.error('Search failed:', e);
  }

  console.log('\n--- Testing Crypto Extraction ---');
  const text = 'Will $BTC hit $100k and $ETH hit 10k? And what about $1000 plain text?';
  const symbols = extractCryptoSymbols(text);
  console.log('Extracted symbols:', symbols);

  console.log('\n--- Testing CoinMarketCap API ---');
  try {
    const prices = await fetchCryptoPrices(symbols);
    console.log('Prices:', prices);
  } catch (e) {
    console.error('CMC failed:', e);
  }
}

runTests();
