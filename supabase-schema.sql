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
  -- 'pending'  = access reserved, micro-payment submitted but not yet confirmed
  -- 'confirmed'= payment settled, durable access granted
  status text not null default 'confirmed',
  amount_usdc numeric not null default 0,
  tx_id text,
  created_at timestamptz default now(),
  confirmed_at timestamptz,
  unique (user_id, signal_id)
);

create index if not exists alpha_unlocks_user_idx on alpha_unlocks(user_id);

-- If alpha_unlocks already exists from an earlier deploy, add the new columns:
alter table alpha_unlocks add column if not exists status text not null default 'confirmed';
alter table alpha_unlocks add column if not exists confirmed_at timestamptz;
