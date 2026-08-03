/**
 * Long-term fact memory for the agent swarm — Mem0 OSS (mem0ai/oss).
 *
 * Additive + env-gated (AGENT_MEMORY=true). Reuses the existing OpenSearch
 * client as the vector store (zero new infra), Gemini embeddings, and any
 * OpenAI-compatible endpoint from the AGENT_LLM_* pool as the distiller LLM.
 * Never throws — every failure degrades to a no-op so the swarm keeps trading.
 *
 * Layout:
 *   • per-agent memories  → { agentId: 'vega' }  (agent's own lessons)
 *   • swarm/team memories → { userId: 'swarm' }  (shared market lessons)
 *
 * Env:
 *   AGENT_MEMORY=true                      master switch (off by default)
 *   AGENT_MEMORY_LLM_URL/KEY/MODEL         distiller LLM (falls back to
 *                                          AGENT_LLM_URL/KEY/MODEL when the
 *                                          primary isn't a Gemini wire format)
 *   AGENT_MEMORY_EMBED_KEY                 Gemini API key (falls back to
 *                                          GOOGLE_API_KEY, then AGENT_LLM_KEY_5)
 *   AGENT_MEMORY_EMBED_MODEL               default gemini-embedding-001
 *   AGENT_MEMORY_EMBED_DIMS                default 1024
 *   AGENT_MEMORY_INDEX                     OpenSearch collection, default puls-mem0
 */

import { Memory } from 'mem0ai/oss';
import { osClient } from './opensearch.js';

const ENABLED = (process.env.AGENT_MEMORY || '').trim().toLowerCase() === 'true';

let memory = null;
let initAttempted = false;
let bootLog = null;

// Pick the distiller LLM from the AGENT_LLM_* pool: explicit AGENT_MEMORY_LLM_*
// wins; else the primary AGENT_LLM_* — but only when it speaks the
// OpenAI-compatible wire format (a Gemini-format primary is unusable here).
function pickLlmConfig() {
  let url = (process.env.AGENT_MEMORY_LLM_URL || '').trim();
  let key = (process.env.AGENT_MEMORY_LLM_KEY || '').trim();
  let model = (process.env.AGENT_MEMORY_LLM_MODEL || '').trim();
  let format = (process.env.AGENT_MEMORY_LLM_FORMAT || '').trim().toLowerCase();

  if (!url || !key || !model) {
    const primary = (process.env.AGENT_LLM_URL || '').trim();
    const isGemini = /generativelanguage\.googleapis\.com/i.test(primary);
    const primaryFormat = (process.env.AGENT_LLM_FORMAT || '').trim().toLowerCase();
    if (primary && !isGemini && primaryFormat !== 'gemini') {
      url = primary;
      key = (process.env.AGENT_LLM_KEY || '').trim();
      model = (process.env.AGENT_MODEL || '').trim();
    }
  }
  if (!url || !key || !model) return null;
  if (format === 'gemini') return null; // needs OpenAI wire format
  if (!/\/(chat\/)?completions\/?$/.test(url)) url = url.replace(/\/+$/, '') + '/chat/completions';
  return {
    provider: 'openai',
    config: { baseURL: url, apiKey: key, model,
      timeout: parseInt(process.env.AGENT_MEMORY_LLM_TIMEOUT_MS || '60000', 10) },
  };
}

function pickEmbedderConfig() {
  const key = (process.env.AGENT_MEMORY_EMBED_KEY || process.env.GOOGLE_API_KEY || process.env.AGENT_LLM_KEY_5 || '').trim();
  if (!key) return null;
  return {
    provider: 'google',
    config: {
      apiKey: key,
      model: (process.env.AGENT_MEMORY_EMBED_MODEL || '').trim() || 'gemini-embedding-001',
      embeddingDims: parseInt(process.env.AGENT_MEMORY_EMBED_DIMS || '1024', 10),
    },
  };
}

// Pre-create the collection with an hnsw engine (mem0's default nmslib engine
// was dropped by newer OpenSearch versions). When the index already exists
// mem0 skips its own (nmslib) creation and reuses ours.
async function ensureIndex(collectionName, dims) {
  if (!osClient) throw new Error('OpenSearch client unavailable');
  try {
    const exists = await osClient.indices.exists({ index: collectionName });
    const isThere = typeof exists === 'boolean' ? exists : !(exists && exists.body === false && exists.statusCode !== 404);
    if (!isThere) {
      await osClient.indices.create({
        index: collectionName,
        body: {
          settings: { index: { knn: true } },
          mappings: {
            properties: {
              vector_field: {
                type: 'knn_vector',
                dimension: dims,
                method: { engine: 'hnsw', name: 'hnsw', space_type: 'cosinesimil' },
              },
              payload: { type: 'object' },
              id: { type: 'keyword' },
            },
          },
        },
      });
      console.log(`[mem0] created index ${collectionName} (${dims}d, hnsw)`);
    }
  } catch (e) {
    throw new Error(`mem0 index setup failed: ${e.message}`);
  }
}

async function getMemory() {
  if (!ENABLED) return null;
  if (initAttempted) return memory;
  initAttempted = true;

  try {
    if (!osClient) throw new Error('OpenSearch client unavailable');
    const llm = pickLlmConfig();
    if (!llm) throw new Error('no OpenAI-compatible distiller LLM configured (set AGENT_MEMORY_LLM_URL/KEY/MODEL)');
    const embedder = pickEmbedderConfig();
    if (!embedder) throw new Error('no Gemini embedder key (set AGENT_MEMORY_EMBED_KEY / GOOGLE_API_KEY / AGENT_LLM_KEY_5)');

    const dims = embedder.config.embeddingDims;
    const collectionName = (process.env.AGENT_MEMORY_INDEX || '').trim() || 'puls-mem0';
    await ensureIndex(collectionName, dims);

    memory = new Memory({
      llm,
      embedder,
      vectorStore: {
        provider: 'opensearch',
        config: { client: osClient, collectionName, embeddingModelDims: dims },
      },
      disableHistory: true,
    });
    bootLog = `[mem0] memory on: ${llm.config.model} @ ${llm.config.baseURL} | ${embedder.config.model} (${dims}d) | index ${collectionName}`;
    console.log(bootLog);
  } catch (e) {
    bootLog = `[mem0] DISABLED: ${e.message}`;
    console.warn(bootLog);
  }
  return memory;
}

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`mem0 timeout after ${ms}ms`)), ms)),
]);

/**
 * Distill the agent's decision into long-term facts (fire-and-forget).
 * @param {string} agentKey  e.g. 'vega'
 * @param {{ question: string, side: string, confidence: number, reasoning: string, pmYes: number|null, slug: string|null, outcome: string|null }} d
 */
export async function rememberAgent(agentKey, d) {
  const m = await getMemory();
  if (!m || !d || !d.question) return null;
  const user = `Decision on "${String(d.question).slice(0, 240)}" — consensus YES ${d.pmYes != null ? `${Math.round(d.pmYes * 100)}¢` : 'n/a'}. I took ${d.side || 'NO side'} with ${d.confidence != null ? `${d.confidence}%` : 'n/a'} confidence.${d.outcome ? ` Outcome: ${d.outcome}.` : ''}`;
  const assistant = String(d.reasoning || '').slice(0, 600) || 'No reasoning recorded.';
  try {
    return await withTimeout(m.add([{ role: 'user', content: user }, { role: 'assistant', content: assistant }], {
      agentId: agentKey,
      metadata: { kind: 'decision', slug: d.slug || null, side: d.side || null, confidence: d.confidence ?? null, at: new Date().toISOString() },
    }), 45000);
  } catch (e) {
    console.warn(`[mem0] remember(${agentKey}) failed: ${e.message}`);
    return null;
  }
}

/** Shared swarm memory: one agent's hard-won lesson becomes everyone's. */
export async function rememberTeam(d) {
  const m = await getMemory();
  if (!m || !d || !d.question) return null;
  const user = `Market lesson worth sharing with the swarm — "${String(d.question).slice(0, 240)}" — consensus YES ${d.pmYes != null ? `${Math.round(d.pmYes * 100)}¢` : 'n/a'}, my side ${d.side || 'n/a'} at ${d.confidence != null ? `${d.confidence}%` : 'n/a'} confidence.${d.outcome ? ` Outcome: ${d.outcome}.` : ''}`;
  const assistant = String(d.reasoning || '').slice(0, 600) || 'No reasoning recorded.';
  try {
    return await withTimeout(m.add([{ role: 'user', content: user }, { role: 'assistant', content: assistant }], {
      userId: 'swarm',
      metadata: { kind: 'lesson', slug: d.slug || null, side: d.side || null, confidence: d.confidence ?? null, at: new Date().toISOString() },
    }), 45000);
  } catch (e) {
    console.warn(`[mem0] rememberTeam failed: ${e.message}`);
    return null;
  }
}

/**
 * Recall the agent's own distilled facts for a market question.
 * @returns {string} compact prompt-ready text ('' when off/failing)
 */
export async function recallAgent(agentKey, query, topK = 4) {
  const m = await getMemory();
  if (!m || !query) return '';
  try {
    const res = await withTimeout(m.search(String(query), { agentId: agentKey, topK }), 25000);
    const hits = (res && res.results) || [];
    if (!hits.length) return '';
    return hits
      .filter(h => h && h.memory)
      .slice(0, topK)
      .map(h => `• ${String(h.memory).slice(0, 160)}`)
      .join('\n');
  } catch (e) {
    console.warn(`[mem0] recall(${agentKey}) failed: ${e.message}`);
    return '';
  }
}

/** Recall shared swarm lessons. */
export async function recallTeam(query, topK = 3) {
  const m = await getMemory();
  if (!m || !query) return '';
  try {
    const res = await withTimeout(m.search(String(query), { userId: 'swarm', topK }), 25000);
    const hits = (res && res.results) || [];
    if (!hits.length) return '';
    return hits
      .filter(h => h && h.memory)
      .slice(0, topK)
      .map(h => `• ${String(h.memory).slice(0, 160)}`)
      .join('\n');
  } catch (e) {
    console.warn(`[mem0] recallTeam failed: ${e.message}`);
    return '';
  }
}

export function memoryStatus() {
  return { enabled: ENABLED, initAttempted, bootLog };
}
