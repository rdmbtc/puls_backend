-- ── Puls Invest — real USDC sponsorship of AI agents on Arc ────────────────
-- Investors pay USDC via x402/Gateway (payee = treasury seller wallet); the
-- backend records the investment, accrues pro-rata agent PnL, and pays out
-- claimable amounts on demand. See docs/superpowers/specs/2026-08-02-puls-invest-design.md.
create table if not exists investments (
  id text primary key,                          -- 'inv_' || <x402 payment id>
  payment_id text unique not null,              -- x402_payments.id that funded it
  investor_address text not null,
  agent_id text not null,
  amount_usdc numeric not null,
  status text not null default 'active',        -- 'active' | 'withdrawn'
  created_at timestamptz not null default now()
);

create index if not exists investments_investor_idx on investments(investor_address);
create index if not exists investments_agent_idx on investments(agent_id);

create table if not exists invest_payouts (
  id text primary key,                          -- 'pay_' || random
  investment_id text references investments(id),
  investor_address text not null,
  amount_usdc numeric not null,
  tx_hash text,
  created_at timestamptz not null default now()
);
