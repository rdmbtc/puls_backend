// ── Agent web research (keyless) ──────────────────────────────────────────────
//
// Gives the autonomous agent "eyes on the open internet" before it decides.
// Inspired by Agent-Reach's capability layer, but implemented as plain HTTP
// calls (no Python CLI, no cookies, no API keys, no risk to the prod backend):
//
//   search:  Jina Reader (r.jina.ai) over DuckDuckGo Lite — returns clean
//            markdown snippets (title · summary · source · date) for a query.
//   read:    Jina Reader (r.jina.ai) over any URL — clean markdown of a page.
//
// Both endpoints are free and keyless. This turns Pulse from a pure price
// arbitrageur into an agent that researches real-world signal before trading:
// it pulls fresh news/sentiment on the market question, feeds it to the LLM,
// and cites a source in its reasoning.
//
// Best-effort by design: any failure returns an empty result so the agent still
// trades — research enriches the decision, it never blocks it.

const JINA_READER = 'https://r.jina.ai/';
const DDG_LITE = 'https://lite.duckduckgo.com/lite/';
const RESEARCH_TIMEOUT_MS = parseInt(process.env.AGENT_RESEARCH_TIMEOUT_MS || '12000', 10);
const RESEARCH_ENABLED = String(process.env.AGENT_RESEARCH_ENABLED ?? 'true').toLowerCase() !== 'false';

async function fetchText(url, { timeoutMs = RESEARCH_TIMEOUT_MS, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (PulsAgent research)', Accept: 'text/plain, */*', ...headers },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the markdown Jina returns for a DuckDuckGo Lite results page into
 * structured { title, url, snippet, source } items.
 */
function parseDdgMarkdown(md, limit) {
  const results = [];
  // Lines like: "1.[Title](https://duckduckgo.com/l/?uddg=<encoded real url>...)"
  const re = /\d+\.\s*\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
  let m;
  while ((m = re.exec(md)) && results.length < limit) {
    const title = m[1].replace(/\*\*/g, '').trim();
    let url = m[2];
    // DDG wraps the real URL in ?uddg=<encoded>; unwrap it.
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch (_) {} }
    if (/duckduckgo\.com\/(y\.js|l\/)/.test(url)) continue; // skip ad/redirect noise
    // The snippet is the text block after the link up to the next numbered item.
    const after = md.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const snippet = after
      .split(/\n\d+\.\s*\[/)[0]
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280);
    let source = '';
    try { source = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}
    results.push({ title, url, snippet, source });
  }
  return results;
}

/**
 * Web search → top results for a query (keyless). Returns [] on any failure.
 * @param {string} query
 * @param {number} [limit=5]
 */
export async function webSearch(query, limit = 5) {
  if (!RESEARCH_ENABLED || !query) return [];
  try {
    const target = `${DDG_LITE}?q=${encodeURIComponent(query)}`;
    const md = await fetchText(`${JINA_READER}${target}`, { headers: { 'X-Respond-With': 'markdown' } });
    return parseDdgMarkdown(md, limit);
  } catch (e) {
    console.warn('[research] webSearch failed:', e.message);
    return [];
  }
}

/**
 * Read a single URL as clean markdown (keyless). Returns '' on failure.
 * @param {string} url
 * @param {number} [maxChars=4000]
 */
export async function readUrl(url, maxChars = 4000) {
  if (!RESEARCH_ENABLED || !url) return '';
  try {
    const md = await fetchText(`${JINA_READER}${url}`);
    return md.slice(0, maxChars);
  } catch (e) {
    console.warn('[research] readUrl failed:', e.message);
    return '';
  }
}

// Pull the most useful lines out of a fetched page's markdown: drop nav / image
// / link noise, then prefer lines that mention the query terms or carry dates /
// times / numbers (schedules, odds, results). Keeps the brief dense + on-topic.
function extractRelevant(md, query, maxChars = 900) {
  if (!md) return '';
  const lines = md
    .split('\n')
    .map((l) => l
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')      // links → their text
      .replace(/[*_>#|~]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter((l) => l.length > 3 && !/^https?:\/\//i.test(l));
  const words = query.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const dateRe = /\b(20\d{2}|\d{1,2}:\d{2}|\d{1,2}\s?(?:am|pm)|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)\b/i;
  const scored = lines.map((l, idx) => {
    const low = l.toLowerCase();
    let score = words.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0);
    if (dateRe.test(l)) score += 1;
    return { l, idx, score };
  });
  const hit = scored.filter((s) => s.score > 0);
  const chosen = (hit.length
    ? hit.sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, 24)
    : scored.slice(0, 14))
    .sort((a, b) => a.idx - b.idx)
    .map((s) => s.l);
  const out = [];
  for (const l of chosen) if (out[out.length - 1] !== l) out.push(l);
  return out.join('\n').slice(0, maxChars);
}

/**
 * Research a question: search the web AND read the top result pages so the brief
 * carries real facts (schedules, dates, figures) — not just snippet teasers.
 * `AGENT_RESEARCH_DEEP` (default 2) = how many of the top pages to actually read.
 * Reads run in parallel and are best-effort; a failed/slow read falls back to
 * its snippet. Always safe.
 * @param {string} question
 */
export async function researchQuestion(question, limit = 4) {
  const hits = await webSearch(question, limit);
  if (hits.length === 0) return { brief: '', sources: [] };
  const deepN = Math.max(0, Math.min(hits.length, parseInt(process.env.AGENT_RESEARCH_DEEP || '2', 10)));
  let pages = [];
  if (deepN > 0) {
    pages = await Promise.all(
      hits.slice(0, deepN).map((h) =>
        readUrl(h.url, 2000).then((md) => extractRelevant(md, question, 900)).catch(() => '')
      )
    );
  }
  const brief = hits
    .map((h, i) => {
      const body = (i < deepN && pages[i]) ? pages[i] : h.snippet;
      return `[${i + 1}] ${h.title} (${h.source})\n${body}`;
    })
    .join('\n\n')
    .slice(0, 3500);
  const sources = hits.map((h) => ({ title: h.title, url: h.url, source: h.source }));
  return { brief, sources };
}
