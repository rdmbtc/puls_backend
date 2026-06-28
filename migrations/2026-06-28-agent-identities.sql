-- Durable ERC-8004 token id per agent.
--
-- The Swarm > Agent list showed a CHANGING ERC-8004 id because the "already
-- registered?" guard was in-memory only (reset on every restart) and the id
-- lookup scanned just the last ~9000 blocks. After the window passed, an agent
-- looked unregistered and was re-minted a NEW identity each restart.
--
-- The code fix stops re-minting (on-chain balanceOf guard). This table makes the
-- DISPLAYED id permanently stable: resolveAgentTokenId() persists the id here
-- once resolved and reads it first on subsequent starts — independent of the
-- event-scan window. Safe/idempotent; the backend works without it (it just
-- falls back to the bounded event scan until this is applied).
create table if not exists agent_identities (
  agent_key  text primary key,
  token_id   text not null,
  address    text,
  updated_at timestamptz default now()
);
