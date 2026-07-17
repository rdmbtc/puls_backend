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
const RESEARCH_TIMEOUT_MS = parseInt(process.env.AGENT_RESEARCH_TIMEOUT_MS || '15000', 10);
const RESEARCH_ENABLED = String(process.env.AGENT_RESEARCH_ENABLED ?? 'true').toLowerCase() !== 'false';

import { Composio } from '@composio/core';
import { extractCryptoSymbols } from './crypto_oracle.js';

// New Advanced Research APIs
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY || '';
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
const ALPHAI_API_KEY = process.env.ALPHAI_API_KEY || '';
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || '';

let composioClient = null;
if (COMPOSIO_API_KEY) {
  try { composioClient = new Composio({ apiKey: COMPOSIO_API_KEY }); } catch(e) {}
}

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
 * Web search → top results for a query. Tries Tavily, then Serper, falls back to DDG.
 * Returns { results: [{title, url, snippet, source, rawContent}], provider } or [] on failure.
 * @param {string} query
 * @param {number} [limit=5]
 */
export async function webSearch(query, limit = 8) {
  if (!RESEARCH_ENABLED || !query) return [];
  
  if (TAVILY_API_KEY) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), RESEARCH_TIMEOUT_MS);
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query: query,
          search_depth: 'advanced',
          include_answer: true,
          include_raw_content: true,
          max_results: limit
        }),
        signal: ac.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const results = (data.results || []).map(r => {
          let source = '';
          try { source = new URL(r.url).hostname.replace(/^www\./, ''); } catch (_) {}
          return {
            title: r.title, url: r.url, snippet: r.content, source, rawContent: r.raw_content, answer: data.answer
          };
        });
        return { results, provider: 'tavily', answer: data.answer };
      }
    } catch (e) {
      console.warn('[research] Tavily search failed, falling back:', e.message);
    }
  }

  if (SERPER_API_KEY) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), RESEARCH_TIMEOUT_MS);
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: limit }),
        signal: ac.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const results = (data.organic || []).map(r => {
          let source = '';
          try { source = new URL(r.link).hostname.replace(/^www\./, ''); } catch (_) {}
          return {
            title: r.title, url: r.link, snippet: r.snippet, source
          };
        });
        return { results, provider: 'serper' };
      }
    } catch (e) {
      console.warn('[research] Serper search failed, falling back:', e.message);
    }
  }

  try {
    const target = `${DDG_LITE}?q=${encodeURIComponent(query)}`;
    const md = await fetchText(`${JINA_READER}${target}`, { headers: { 'X-Respond-With': 'markdown' } });
    return { results: parseDdgMarkdown(md, limit), provider: 'ddg' };
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
  
  if (FIRECRAWL_API_KEY) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), RESEARCH_TIMEOUT_MS * 2);
      const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FIRECRAWL_API_KEY}` },
        body: JSON.stringify({ url, formats: ['markdown'] }),
        signal: ac.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data && data.data.markdown) {
          return data.data.markdown.slice(0, maxChars);
        }
      }
    } catch (e) {
      console.warn('[research] FireCrawl readUrl failed, falling back to Jina:', e.message);
    }
  }

  try {
    const md = await fetchText(`${JINA_READER}${url}`);
    return md.slice(0, maxChars);
  } catch (e) {
    console.warn('[research] readUrl failed:', e.message);
    return '';
  }
}

async function fetchAlphaINews(question) {
  if (!ALPHAI_API_KEY) return '';
  const symbols = extractCryptoSymbols(question);
  if (!symbols || symbols.length === 0) return '';
  
  const symbol = symbols[0]; // grab primary symbol
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RESEARCH_TIMEOUT_MS);
    const url = `https://api.alphai.io/api/news/?symbol=${encodeURIComponent(symbol)}&min_relevance=7`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ALPHAI_API_KEY}` },
      signal: ac.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const articles = data.slice(0, 3).map(a => `- ${a.headline} (Sentiment: ${a.sentiment || 'Neutral'})`).join('\n');
        return `ALPHAI CRYPTO SENTIMENT FOR ${symbol}:\n${articles}\n\n`;
      }
    }
  } catch (e) {
    console.warn(`[research] AlphaI failed for ${symbol}:`, e.message);
  }
  return '';
}

async function fetchComposioSocial(question) {
  if (!composioClient) return '';
  let socialBrief = '';
  
  // A simple fallback keyword extraction for search
  const keywords = question.split(' ').slice(0, 3).join(' ');
  
  try {
    // Attempt to search X (Twitter), Reddit, and GitHub for the market topic
    // Note: This requires the user to authenticate these apps in the Composio dashboard
    // for the 'default' entity, otherwise the tool execution will be rejected.
    const tasks = [];
    tasks.push(composioClient.tools.execute('TWITTER_SEARCH_RECENT', { query: keywords }, 'default').catch(() => null));
    tasks.push(composioClient.tools.execute('REDDIT_SEARCH', { query: keywords }, 'default').catch(() => null));
    tasks.push(composioClient.tools.execute('GITHUB_SEARCH_ISSUES', { query: keywords }, 'default').catch(() => null));
    
    const [twitterRes, redditRes, githubRes] = await Promise.all(tasks);
    
    if (twitterRes && twitterRes.success) socialBrief += `[Twitter Trend]: ${JSON.stringify(twitterRes.data).slice(0, 200)}\n`;
    if (redditRes && redditRes.success) socialBrief += `[Reddit Trend]: ${JSON.stringify(redditRes.data).slice(0, 200)}\n`;
    if (githubRes && githubRes.success) socialBrief += `[GitHub Trend]: ${JSON.stringify(githubRes.data).slice(0, 200)}\n`;
    
  } catch (e) {
    console.warn(`[research] Composio Social Research failed:`, e.message);
  }
  
  if (socialBrief) return `COMPOSIO SOCIAL TRENDS:\n${socialBrief}\n\n`;
  return '';
}

// Pull the most useful lines out of a fetched page's markdown: drop nav / image
// / link noise, then prefer lines that mention the query terms or carry dates /
// times / numbers (schedules, odds, results). Keeps the brief dense + on-topic.
function extractRelevant(md, query, maxChars = 1800) {
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
 * Reads run in parallel and are best-effort; a failed/slow read falls back to
 * its snippet. Always safe.
 * @param {string} question
 */
export async function researchQuestion(question, limit = 8) {
  const searchObj = await webSearch(question, limit);
  if (!searchObj || !searchObj.results || searchObj.results.length === 0) return { brief: '', sources: [] };
  
  const hits = searchObj.results;
  const provider = searchObj.provider;
  let brief = await fetchAlphaINews(question);
  brief += await fetchComposioSocial(question);

  if (provider === 'tavily') {
    // Tavily Deep Research already provides raw content and an AI answer
    brief = searchObj.answer ? `TAVILY AI ANSWER: ${searchObj.answer}\n\n` : '';
    brief += hits
      .map((h, i) => {
        const body = h.rawContent ? extractRelevant(h.rawContent.slice(0, 4000), question, 1800) : h.snippet;
        return `[${i + 1}] ${h.title} (${h.source})\n${body || h.snippet}`;
      })
      .join('\n\n');
  } else {
    // Fallback DDG/Serper behaviour - fetch top pages
    const deepN = Math.max(0, Math.min(hits.length, parseInt(process.env.AGENT_RESEARCH_DEEP || '6', 10)));
    let pages = [];
    if (deepN > 0) {
      pages = await Promise.all(
        hits.slice(0, deepN).map((h) =>
          readUrl(h.url, 4000).then((md) => extractRelevant(md, question, 1800)).catch(() => '')
        )
      );
    }
    brief = hits
      .map((h, i) => {
        const body = (i < deepN && pages[i]) ? pages[i] : h.snippet;
        return `[${i + 1}] ${h.title} (${h.source})\n${body}`;
      })
      .join('\n\n');
  }

  const sources = hits.slice(0, 10).map((h) => ({ title: h.title, url: h.url, source: h.source }));
  return { brief: brief.slice(0, 5000), sources };
}
