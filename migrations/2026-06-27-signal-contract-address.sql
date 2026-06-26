-- Link a creator Signal to its deployed market contract so the bond reconciler
-- can look up the slug via contractToSlugCache when market_slug is null.
alter table if exists creator_signals
  add column if not exists contract_address text;
