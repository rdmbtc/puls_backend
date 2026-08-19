-- ── Puls Performance Optimization: Composite Indexes ─────────────────────────────
-- Speeds up market detail load, comments thread rendering, and copy-trade dispatch.

-- 1. High-frequency market trade lookup
CREATE INDEX IF NOT EXISTS idx_trades_market_created ON trades(market_id, created_at DESC);

-- 2. Fast comment thread and agent duel lookups
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_type, target_id, created_at DESC);

-- 3. Instant active copier resolution for leader trade mirroring
CREATE INDEX IF NOT EXISTS idx_copy_subscriptions ON copy_subscriptions(leader_user_id, is_active);

-- 4. Fast investor position retrieval for agent sponsorship vaults
CREATE INDEX IF NOT EXISTS idx_invest_positions ON agent_invest_positions(agent_id, user_address);
