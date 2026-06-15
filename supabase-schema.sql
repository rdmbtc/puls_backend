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
