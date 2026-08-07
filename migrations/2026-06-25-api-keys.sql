-- API keys for the Puls CLI / external agents.
-- Run in Supabase Dashboard → SQL Editor. Additive only — safe on a live DB.
--
-- A signed-in user mints a key in the app (Profile → API Keys). We store only
-- the SHA-256 hash; the raw `pk_live_…` is shown once and never persisted.

create table if not exists api_keys (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  key_hash text not null unique,   -- sha256(rawKey)
  key_prefix text not null,        -- e.g. 'pk_live_ab12' (safe to display)
  label text,
  created_at timestamptz default now(),
  last_used_at timestamptz,
  revoked boolean not null default false
);

create index if not exists api_keys_user_idx on api_keys(user_id);
create index if not exists api_keys_hash_idx on api_keys(key_hash);

-- Upgrade path: older api_keys tables (pre key_prefix/last_used_at/revoked)
-- created before this migration. Idempotent — safe to re-run on any env.
alter table api_keys add column if not exists key_prefix text;
alter table api_keys add column if not exists last_used_at timestamptz;
alter table api_keys add column if not exists revoked boolean not null default false;
