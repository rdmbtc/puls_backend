/**
 * News-Triggered Autonomous Market Creator
 *
 * Enables AI creator agents (e.g. Sage 🧠, Nova 🌟) to discover breaking news,
 * synthesize unambiguous binary prediction questions with deterministic resolution rules,
 * and publish new markets with initial liquidity.
 */

/**
 * Transforms raw news event data into a formatted prediction market specification.
 *
 * @param {Object} item
 * @param {string} item.title - News headline
 * @param {string} [item.summary] - News brief/context
 * @param {string} [item.sourceUrl] - Sourced reference link
 * @param {string} [item.category='AI & Tech'] - Market category
 * @param {number} [item.daysUntilClose=14] - Horizon in days
 * @param {string} [item.creator='Sage 🧠'] - Agent name
 * @returns {Object} Full market specification ready for LMSR deployment
 */
export function synthesizeMarketFromNews({
  title,
  summary = '',
  sourceUrl = '',
  category = 'AI & Tech',
  daysUntilClose = 14,
  creator = 'Sage 🧠',
}) {
  if (!title || typeof title !== 'string' || title.trim().length < 5) {
    throw new Error('Valid news title is required');
  }

  const cleanTitle = title.trim();
  const slug = cleanTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 60);

  const now = Date.now();
  const closeDate = new Date(now + Math.max(1, daysUntilClose) * 24 * 60 * 60 * 1000);

  // Formulate a crisp binary prediction question if not already ending in a question mark
  let question = cleanTitle;
  if (!question.endsWith('?')) {
    if (!question.toLowerCase().startsWith('will')) {
      question = `Will ${question}?`;
    } else {
      question = `${question}?`;
    }
  }

  const resolutionCriteria = `This market will resolve to YES if ${cleanTitle} is verified by primary reporting (e.g. ${sourceUrl ? new URL(sourceUrl).hostname : 'credible news outlets'}) prior to ${closeDate.toISOString().split('T')[0]} 23:59 UTC. Otherwise, resolves to NO.`;

  return {
    slug: `news-${slug}-${Math.floor(now / 1000).toString().slice(-4)}`,
    question,
    description: summary || `Autonomous market created by ${creator} from verified breaking news.`,
    resolutionCriteria,
    category,
    sourceUrl: sourceUrl || 'https://news.google.com',
    creator,
    creatorType: 'agent',
    closesAt: closeDate.toISOString(),
    initialProbability: 0.50,
    initialLiquidityUsdc: 5.0,
    createdAt: new Date(now).toISOString(),
    status: 'ACTIVE',
  };
}

/**
 * Registers Express routes for news-triggered market creation.
 */
export function registerNewsCreatorRoutes(app, { supabase } = {}) {
  const candidates = [];

  app.post('/api/markets/create-from-news', async (req, res) => {
    try {
      const { title, summary, sourceUrl, category, daysUntilClose, creator } = req.body || {};
      const marketSpec = synthesizeMarketFromNews({
        title,
        summary,
        sourceUrl,
        category,
        daysUntilClose,
        creator,
      });

      candidates.unshift(marketSpec);
      if (candidates.length > 50) candidates.pop();

      return res.status(201).json({
        ok: true,
        market: marketSpec,
        message: 'Autonomous market candidate synthesized successfully',
      });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/markets/news-candidates', (req, res) => {
    return res.json({
      ok: true,
      candidates,
      total: candidates.length,
    });
  });
}
