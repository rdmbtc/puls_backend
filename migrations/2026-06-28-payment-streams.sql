-- Puls Streams — pay-per-second USDC streaming on Arc.
--
-- A stream is a continuous authorization: the payer approves a RATE ($/sec) and
-- a CAP, the meter accrues per second while the consumer keeps "ticking"
-- (proof-of-flow), and accrual is settled to the recipient(s) in batches as real
-- on-chain USDC transfers. Amounts are tracked in integer micro-USDC (6 dp) to
-- avoid float drift; split is a [{address, bps}] live revenue split.
create table if not exists payment_streams (
  id                 uuid primary key default gen_random_uuid(),
  payer_user_id      text not null,
  payer_address      text,
  recipient_user_id  text,
  recipient_address  text not null,
  resource           text,
  rate_per_sec_usdc  numeric not null,
  cap_usdc           numeric not null,
  status             text not null default 'active',   -- active | paused | stopped
  accrued_micro      bigint not null default 0,        -- total metered (micro-USDC)
  settled_micro      bigint not null default 0,        -- total settled on-chain (micro-USDC)
  split              jsonb,                            -- [{address, bps}] sums to 10000
  opened_by          text default 'user',              -- 'user' | 'agent'
  meta               jsonb,
  settle_tx          text,
  last_tick_at       timestamptz default now(),
  started_at         timestamptz default now(),
  stopped_at         timestamptz,
  updated_at         timestamptz default now()
);

create index if not exists payment_streams_payer_idx     on payment_streams (payer_user_id, status);
create index if not exists payment_streams_recipient_idx on payment_streams (recipient_user_id);
create index if not exists payment_streams_status_idx    on payment_streams (status);
