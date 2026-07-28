import { Client } from '@opensearch-project/opensearch';

const OPENSEARCH_URL = process.env.OPENSEARCH_URL;

let osClient = null;
if (OPENSEARCH_URL) {
  try {
    osClient = new Client({
      node: OPENSEARCH_URL,
      ssl: { rejectUnauthorized: false }
    });
    console.log('[opensearch] initialized client');
  } catch (err) {
    console.error('[opensearch] client init failed:', err.message);
  }
} else {
  console.log('[opensearch] OPENSEARCH_URL not set, running without semantic search');
}

function inferCategory(text = '') {
  const t = text.toLowerCase();
  if (t.includes('btc') || t.includes('eth') || t.includes('sol') || t.includes('crypto') || t.includes('bitcoin') || t.includes('ethereum') || t.includes('usdc')) return 'crypto';
  if (t.includes('fed') || t.includes('rate') || t.includes('cpi') || t.includes('stock') || t.includes('gdp') || t.includes('inflation') || t.includes('market')) return 'finance';
  if (t.includes('f1') || t.includes('nba') || t.includes('nfl') || t.includes('cup') || t.includes('game') || t.includes('vs') || t.includes('win')) return 'sports';
  if (t.includes('trump') || t.includes('biden') || t.includes('election') || t.includes('president') || t.includes('vote')) return 'politics';
  if (t.includes('ai') || t.includes('gpt') || t.includes('model') || t.includes('nvidia') || t.includes('apple') || t.includes('tech')) return 'tech';
  return 'general';
}

const INDICES = {
  markets: {
    index: 'puls-markets',
    mappings: {
      properties: {
        slug: { type: 'keyword' },
        question: { type: 'text', analyzer: 'standard' },
        category: { type: 'keyword' },
        yesPrice: { type: 'float' },
        volume: { type: 'float' },
        resolved: { type: 'boolean' },
        outcome: { type: 'keyword' },
        deadline: { type: 'date' },
        updatedAt: { type: 'date' }
      }
    }
  },
  signals: {
    index: 'puls-signals',
    mappings: {
      properties: {
        id: { type: 'keyword' },
        title: { type: 'text', analyzer: 'standard' },
        thesis: { type: 'text', analyzer: 'standard' },
        stance: { type: 'keyword' },
        marketSlug: { type: 'keyword' },
        creatorAgent: { type: 'keyword' },
        priceUsdc: { type: 'float' },
        createdAt: { type: 'date' }
      }
    }
  },
  decisions: {
    index: 'puls-decisions',
    mappings: {
      properties: {
        agentKey: { type: 'keyword' },
        action: { type: 'keyword' },
        question: { type: 'text', analyzer: 'standard' },
        reasoning: { type: 'text', analyzer: 'standard' },
        side: { type: 'keyword' },
        amount: { type: 'float' },
        confidence: { type: 'integer' },
        outcome: { type: 'keyword' },
        at: { type: 'date' }
      }
    }
  }
};

export async function initIndices() {
  if (!osClient) return;
  for (const [name, def] of Object.entries(INDICES)) {
    try {
      const res = await osClient.indices.exists({ index: def.index });
      const isExist = typeof res === 'boolean' ? res : (res && res.body !== false && res.statusCode !== 404);
      if (!isExist) {
        await osClient.indices.create({
          index: def.index,
          body: { mappings: def.mappings }
        }).catch(err => console.warn(`[opensearch] index create warning ${def.index}:`, err.message));
        console.log(`[opensearch] created index: ${def.index}`);
      }
    } catch (e) {
      await osClient.indices.create({
        index: def.index,
        body: { mappings: def.mappings }
      }).catch(err => console.warn(`[opensearch] index create error for ${def.index}:`, err.message));
    }
  }
}

export async function indexMarket(market) {
  if (!osClient || !market?.slug) return;
  try {
    const slug = market.slug;
    const question = market.question || slug;
    await osClient.index({
      index: 'puls-markets',
      id: slug,
      body: {
        slug,
        question,
        category: market.category || inferCategory(question),
        yesPrice: parseFloat(market.yesPrice || market.yes_price || 0.5),
        volume: parseFloat(market.volume || market.volume_usdc || 0),
        resolved: Boolean(market.resolved),
        outcome: market.outcome != null ? (market.outcome === true || market.outcome === 'YES' ? 'YES' : 'NO') : null,
        deadline: market.deadline ? new Date(typeof market.deadline === 'number' ? market.deadline * 1000 : market.deadline).toISOString() : null,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.warn('[opensearch] indexMarket error:', err.message);
  }
}

export async function indexSignal(signal) {
  if (!osClient || !signal?.id) return;
  try {
    await osClient.index({
      index: 'puls-signals',
      id: String(signal.id),
      body: {
        id: String(signal.id),
        title: signal.title || '',
        thesis: signal.thesis || '',
        stance: signal.stance || null,
        marketSlug: signal.market_slug || signal.marketSlug || '',
        creatorAgent: signal.creator_user_id || signal.creatorAgent || '',
        priceUsdc: parseFloat(signal.price_usdc || signal.priceUsdc || 0.001),
        createdAt: signal.created_at || signal.createdAt || new Date().toISOString()
      }
    });
  } catch (err) {
    console.warn('[opensearch] indexSignal error:', err.message);
  }
}

export async function indexDecision(agentKey, decision) {
  if (!osClient || !decision) return;
  try {
    const id = `${agentKey}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
    await osClient.index({
      index: 'puls-decisions',
      id,
      body: {
        agentKey,
        action: decision.action || 'go',
        question: decision.question || '',
        reasoning: decision.reasoning || '',
        side: decision.side || null,
        amount: parseFloat(decision.amount || 0),
        confidence: decision.confidence != null ? parseInt(decision.confidence, 10) : null,
        outcome: decision.outcome || null,
        at: decision.at || new Date().toISOString()
      }
    });
  } catch (err) {
    console.warn('[opensearch] indexDecision error:', err.message);
  }
}

// === SEMANTIC SEARCH (RAG) ===

export async function searchMarkets(query, limit = 5) {
  if (!osClient || !query) return [];
  try {
    const res = await osClient.search({
      index: 'puls-markets',
      body: {
        size: limit,
        query: {
          bool: {
            should: [
              { match: { question: { query, boost: 2 } } },
              { match: { category: query } }
            ]
          }
        },
        sort: [{ volume: 'desc' }]
      }
    });
    const hits = res.body?.hits?.hits || res.hits?.hits || [];
    return hits.map(h => ({ ...h._source, score: h._score }));
  } catch (err) {
    console.warn('[opensearch] searchMarkets error:', err.message);
    return [];
  }
}

export async function searchSignals(query, limit = 3) {
  if (!osClient || !query) return [];
  try {
    const res = await osClient.search({
      index: 'puls-signals',
      body: {
        size: limit,
        query: {
          multi_match: {
            query,
            fields: ['title^3', 'thesis^2', 'marketSlug'],
            type: 'best_fields'
          }
        },
        sort: [{ createdAt: 'desc' }]
      }
    });
    const hits = res.body?.hits?.hits || res.hits?.hits || [];
    return hits.map(h => ({ ...h._source, score: h._score }));
  } catch (err) {
    console.warn('[opensearch] searchSignals error:', err.message);
    return [];
  }
}

export async function searchDecisions(query, agentKey = null, limit = 5) {
  if (!osClient || !query) return [];
  try {
    const must = [{ match: { question: query } }];
    if (agentKey) must.push({ term: { agentKey } });

    const res = await osClient.search({
      index: 'puls-decisions',
      body: {
        size: limit,
        query: { bool: { must } },
        sort: [{ at: 'desc' }]
      }
    });
    const hits = res.body?.hits?.hits || res.hits?.hits || [];
    return hits.map(h => ({ ...h._source, score: h._score }));
  } catch (err) {
    console.warn('[opensearch] searchDecisions error:', err.message);
    return [];
  }
}

// Combined RAG retrieval for agent context
export async function retrieveContext(query, agentKey = null) {
  if (!osClient || !query) return { markets: [], signals: [], pastDecisions: [] };
  try {
    const [markets, signals, pastDecisions] = await Promise.all([
      searchMarkets(query, 3),
      searchSignals(query, 2),
      searchDecisions(query, agentKey, 3)
    ]);
    return { markets, signals, pastDecisions };
  } catch (err) {
    console.warn('[opensearch] retrieveContext error:', err.message);
    return { markets: [], signals: [], pastDecisions: [] };
  }
}

export { osClient };
