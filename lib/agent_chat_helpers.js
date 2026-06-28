/**
 * Agent chat helpers — pure, dependency-free resolution logic for the
 * "My Agent" chat endpoint (POST /api/agent/chat).
 *
 * The endpoint asks an LLM to turn free text like "buy the top market" into a
 * structured action. The model often emits the literal phrase as the market
 * reference (e.g. {"type":"buy","market":"top market"}), which then fails
 * fuzzy name matching. These helpers resolve POSITIONAL phrases ("top",
 * "first", "best", "#1", ...) deterministically BEFORE name matching, so the
 * agent reliably buys feed[0] / the top signal instead of saying "I can't find
 * a market named 'top market'".
 *
 * No external deps on purpose: server.js initializes Circle/Supabase/viem at
 * import time, so its functions can't be unit-tested in isolation. Keeping
 * this pure lets `node --test` exercise it directly.
 */

// Tokens that mean "the first / highest-ranked item" (never a real market or
// signal topic). The literal "1" is included so "market #1" / "pick number 1"
// resolve to feed[0].
const POSITIONAL_TOKENS = new Set([
  'top', 'best', 'first', '1st', '1', 'biggest', 'hottest',
  'leading', 'main', 'popular', 'any', 'default',
]);

// Filler words stripped before the positional check: articles, the category
// nouns ("market", "signal"), and the rank prefixes ("number", "no", "nr") so
// "number 1" / "no. 1" collapse to the positional token "1". `most` is here so
// "most popular" → "popular".
const FILLER_RE = /\b(the|a|an|one|ones|market|markets|prediction|predictions|pick|item|items|please|kindly|buy|get|grab|trade|me|you|for|of|number|no|nr|most|signal|signals|forecast|forecasts|alpha)\b/g;

function _norm(s) {
  return String(s == null ? '' : s).toLowerCase().trim();
}

// Tokenize a phrase for the positional check: lowercase → strip filler words
// → drop punctuation (keep "#" and digits) → collapse "#1" / "# 1" → "1".
function _positionalTokens(s) {
  const cleaned = _norm(s)
    .replace(FILLER_RE, ' ')
    .replace(/[^a-z0-9# ]/g, ' ')
    .replace(/#\s*1/g, '1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned.split(' ').filter(Boolean);
}

// True if a phrase is PURELY positional — every remaining token after stripping
// filler is a ranking word. A real market/topic ("Will BTC close above 100k?",
// "crypto signal", "spain round of 16") leaves non-positional tokens behind.
function _isPositional(s) {
  const tokens = _positionalTokens(s);
  if (tokens.length === 0) return false;
  return tokens.every((w) => POSITIONAL_TOKENS.has(w));
}

/**
 * If the LLM emitted a positional reference for a MARKET (or the user's whole
 * message is a bare positional request), return the first market in `feed`.
 * The feed is already sorted deployed-first then by descending volume, so
 * `feed[0]` is the most liquid / most tradeable market — exactly what "top
 * market" should mean.
 *
 * Returns the market object, or `null` when this isn't a positional ref (so
 * the caller falls through to normal name resolution).
 */
export function resolvePositionalMarket(ref, message, feed) {
  if (!Array.isArray(feed) || feed.length === 0) return null;
  const r = _norm(ref);
  // Explicit positional reference on the action's market field.
  if (r && _isPositional(r)) return feed[0];
  // Bare positional request in the message ("buy the top market", "get me the
  // best prediction") with no concrete market named alongside it.
  if (!r && _isPositional(message)) return feed[0];
  return null;
}

/**
 * Normalize a positional SIGNAL reference to the canonical token "top", which
 * the existing buySignalForUserAgent() already treats as "best available
 * signal". Real topics ("crypto signal", "btc signal") are returned cleaned
 * (lowercased) but otherwise untouched.
 *
 * Returns "top" for positionals, otherwise the cleaned query.
 */
export function resolvePositionalSignal(ref, message) {
  const r = _norm(ref);
  if (r && _isPositional(r)) return 'top';
  // Bare "buy the top/best signal" with no topic → "top".
  if (!r && _isPositional(message)) return 'top';
  return r;
}
