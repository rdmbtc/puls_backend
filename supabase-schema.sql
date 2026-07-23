-- Run this in Supabase Dashboard → SQL Editor

create table if not exists wallets (
  user_id text primary key,
  wallet_id text not null,
  last_balance text default '0',
  created_at timestamptz default now()
);

create table if not exists approved_wallets (
  wallet_id text primary key,
  created_at timestamptz default now()
);

create table if not exists trades (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  tx_id text not null,
  side text not null,
  usdc_amount numeric not null,
  entry_price numeric default 0.5,
  question text,
  market_id text,
  state text default 'INITIATED',
  tx_hash text,
  created_at timestamptz default now()
);

create index if not exists trades_user_id_idx on trades(user_id);

create table if not exists deployed_markets (
  slug text primary key,
  contract_address text not null,
  deadline bigint not null,
  resolved boolean default false,
  outcome boolean,
  archived boolean default false,
  created_at timestamptz default now()
);

-- Migration for existing databases:
alter table deployed_markets add column if not exists archived boolean default false;

-- ── x402 creator-monetization layer ──────────────────────────────────────────
-- Records every settled Circle Gateway nanopayment (x402) on Arc Testnet.
create table if not exists x402_payments (
  id uuid default gen_random_uuid() primary key,
  endpoint text not null,
  payer text,
  pay_to text,
  amount_usdc numeric not null,
  network text,
  gateway_tx text,
  raw jsonb,
  created_at timestamptz default now()
);

create index if not exists x402_payments_created_at_idx on x402_payments(created_at desc);
create index if not exists x402_payments_pay_to_idx on x402_payments(pay_to);

-- ── Copy-trade creator layer (T1) ────────────────────────────────────────────
-- A follower opts in to copy a leader's BUYs (scaled to a per-trade cap). Each
-- mirrored trade pays the leader a per-event creator micro-fee (recorded in
-- x402_payments with endpoint='copy_fee'). Live mirroring is gated server-side
-- by env COPY_TRADE_ENABLED.
create table if not exists copy_follows (
  id uuid default gen_random_uuid() primary key,
  follower_user_id text not null,
  leader_user_id text not null,
  max_per_trade_usdc numeric not null default 1,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (follower_user_id, leader_user_id)
);

create index if not exists copy_follows_leader_idx on copy_follows(leader_user_id);
create index if not exists copy_follows_follower_idx on copy_follows(follower_user_id);

-- ── Alpha paid-analysis (T1 creator layer) ───────────────────────────────────
-- A reader unlocks a premium forecast's full thesis by paying the creator a
-- sub-cent USDC micro-fee (recorded in x402_payments with endpoint='alpha_unlock').
-- One row per (user, signal) grants durable access. Live payments are gated
-- server-side by env ALPHA_PAID_ENABLED.
create table if not exists alpha_unlocks (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  signal_id text not null,
  amount_usdc numeric not null default 0,
  tx_id text,
  -- 'pending' = payment submitted / reserved; 'confirmed' = access granted.
  -- We reserve a 'pending' row BEFORE the on-chain transfer and flip it to
  -- 'confirmed' after, so a retry never double-charges (exactly-once unlock).
  status text not null default 'confirmed',
  confirmed_at timestamptz,
  created_at timestamptz default now(),
  unique (user_id, signal_id)
);

create index if not exists alpha_unlocks_user_idx on alpha_unlocks(user_id);

-- Idempotent upgrade for deployments created before the exactly-once columns.
alter table alpha_unlocks add column if not exists status text not null default 'confirmed';
alter table alpha_unlocks add column if not exists confirmed_at timestamptz;

-- ── Comments (community layer, F1) ───────────────────────────────────────────
-- Signed-in users comment on anything (markets, profiles, events, alpha), reply
-- to each other (flattened to one nesting level via parent_id) and like
-- comments. Text is tiny so Supabase free tier is plenty. Soft-delete keeps
-- thread shape (a deleted node with replies renders as "[deleted]").
create table if not exists comments (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  target_type text not null,   -- 'market' | 'profile' | 'event' | 'alpha'
  target_id text not null,
  body text not null,
  parent_id uuid references comments(id) on delete cascade,
  deleted boolean not null default false,
  created_at timestamptz default now()
);

create index if not exists comments_target_idx on comments(target_type, target_id, created_at desc);
create index if not exists comments_parent_idx on comments(parent_id);
create index if not exists comments_user_idx on comments(user_id);

-- One like per (comment, user). Toggling re-inserts/deletes a row.
create table if not exists comment_likes (
  id uuid default gen_random_uuid() primary key,
  comment_id uuid not null references comments(id) on delete cascade,
  user_id text not null,
  created_at timestamptz default now(),
  unique (comment_id, user_id)
);

create index if not exists comment_likes_comment_idx on comment_likes(comment_id);

-- Idempotent upgrade for deployments created before the soft-delete column.
alter table comments add column if not exists deleted boolean not null default false;

-- ── Support tickets (in-app help desk, F5) ───────────────────────────────────
-- Our own ticket support, replacing the region-blocked Tawk.to live-chat. A
-- ticket holds a subject + status; messages thread under it from the user or an
-- admin. Text is tiny so the Supabase free tier is plenty. Same infra as the
-- comments layer (verified-only writes, in-app notifications).
create table if not exists support_tickets (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  subject text not null,
  -- 'open' = awaiting a reply from the desk; 'answered' = admin replied;
  -- 'closed' = resolved (owner or admin can close).
  status text not null default 'open',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists support_tickets_user_idx on support_tickets(user_id, updated_at desc);
create index if not exists support_tickets_status_idx on support_tickets(status, updated_at desc);

create table if not exists support_messages (
  id uuid default gen_random_uuid() primary key,
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  sender text not null,        -- 'user' | 'admin'
  body text not null,
  created_at timestamptz default now()
);

create index if not exists support_messages_ticket_idx on support_messages(ticket_id, created_at asc);

-- ── Referrals (refer-a-friend, invite mechanic only, F3) ─────────────────────
-- NO automatic USDC payout (little testnet USDC + farming risk). Each user gets
-- a stable code + share link; a new user claims a code once. We surface an
-- "invited N friends" badge so referrers climb the social board together.
create table if not exists referral_codes (
  user_id text primary key,
  code text unique not null,
  created_at timestamptz default now()
);

create table if not exists referrals (
  id uuid default gen_random_uuid() primary key,
  referrer_user_id text not null,
  invitee_user_id text not null unique,   -- one attribution per invitee, ever
  code text not null,
  created_at timestamptz default now()
);

create index if not exists referrals_referrer_idx on referrals(referrer_user_id);

-- ── Creator Signals (premium forecasts, on-chain attested, x402 per-read) ─────
-- See migrations/2026-06-17-creator-signals.sql for the full annotated version.
create table if not exists creator_signals (
  id uuid default gen_random_uuid() primary key,
  creator_user_id text not null,
  title text not null,
  market_question text,
  stance text not null default 'YES',
  confidence numeric default 0.6,
  edge_bps integer default 0,
  horizon text,
  teaser text,
  thesis text not null,
  price_usdc numeric not null default 0.001,
  status text not null default 'draft',
  onchain_signal_id text,
  content_hash text,
  onchain_tx text,
  published_at timestamptz,
  views integer not null default 0,
  unlocks_count integer not null default 0,
  revenue_usdc numeric not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists creator_signals_creator_idx
  on creator_signals(creator_user_id, status, updated_at desc);
create index if not exists creator_signals_status_idx
  on creator_signals(status, published_at desc);

create table if not exists signal_unlocks (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  signal_id uuid not null references creator_signals(id) on delete cascade,
  status text not null default 'pending',
  amount_usdc numeric,
  tx_id text,
  created_at timestamptz default now(),
  confirmed_at timestamptz,
  unique (user_id, signal_id)
);

create index if not exists signal_unlocks_user_idx on signal_unlocks(user_id);
create index if not exists signal_unlocks_signal_idx on signal_unlocks(signal_id);

-- ── Protocol stats function (single-query replacement for paginated for-loop) ──
-- Replaces the 22-iteration sequential pagination in /api/stats that took 15-20s.
-- This function runs as a single SQL query — returns in <500ms.
CREATE OR REPLACE FUNCTION get_protocol_stats()
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'trade_count', COUNT(*),
    'volume_usdc', COALESCE(SUM(usdc_amount), 0),
    'agent_trades', COUNT(*) FILTER (WHERE user_id = 'house_pulse' OR user_id LIKE 'agent_%' OR question LIKE '🤖 Agent:%'),
    'agent_volume', COALESCE(SUM(usdc_amount) FILTER (WHERE user_id = 'house_pulse' OR user_id LIKE 'agent_%' OR question LIKE '🤖 Agent:%'), 0),
    'seed_trades', COUNT(*) FILTER (WHERE user_id IN (SELECT user_id FROM wallets WHERE last_balance = 'seed')),
    'seed_volume', COALESCE(SUM(usdc_amount) FILTER (WHERE user_id IN (SELECT user_id FROM wallets WHERE last_balance = 'seed')), 0),
    'agent_count', COUNT(DISTINCT user_id) FILTER (WHERE user_id = 'house_pulse' OR user_id LIKE 'agent_%')
  ) INTO result
  FROM trades WHERE state = 'COMPLETE';
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

