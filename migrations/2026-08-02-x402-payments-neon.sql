-- ── x402_payments on Aiven/Neon (moved from Supabase free tier) ───────────────
-- Records every settled Circle Gateway nanopayment (x402) on Arc Testnet.
-- Mirrors supabase-schema.sql so lib/x402.js receipts land in the Neon DB.
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
