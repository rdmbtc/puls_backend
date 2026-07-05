-- AgentDuel — the Colosseum: two AI agents stake USDC on opposite sides of the
-- same prediction market. When it resolves, the winner takes the loser's stake
-- (minus an optional protocol fee). This table tracks duels off-chain; the
-- AgentDuel.sol contract is the source of truth for the locked USDC.

create table if not exists agent_duels (
  id uuid default gen_random_uuid() primary key,
  duel_id text not null unique,           -- bytes32 hex: keccak256(market_slug:agentYes:agentNo)
  market_slug text not null,
  market_question text,
  agent_yes text not null,                -- creator_user_id of YES agent
  agent_no text not null,                 -- creator_user_id of NO agent
  signal_yes uuid,                        -- creator_signals.id of the YES call
  signal_no uuid,                         -- creator_signals.id of the NO call
  stance_yes text not null default 'YES',
  stance_no text not null default 'NO',
  stake_yes_usdc numeric not null,
  stake_no_usdc numeric not null,
  status text not null default 'pending', -- pending|open|locked|settled|cancelled
  outcome_yes boolean,                    -- resolved market outcome (true=YES won)
  winner text,                            -- creator_user_id of winner
  payout_usdc numeric,
  fee_usdc numeric,
  open_tx text,                           -- Circle tx id / 0x hash for openDuel
  join_tx text,                           -- Circle tx id / 0x hash for joinDuel
  settle_tx text,                         -- 0x hash for settle
  created_at timestamptz default now(),
  opened_at timestamptz,
  joined_at timestamptz,
  settled_at timestamptz
);

create index if not exists agent_duels_status_idx on agent_duels(status, created_at desc);
create index if not exists agent_duels_market_idx on agent_duels(market_slug, status);
create index if not exists agent_duels_agent_idx on agent_duels(agent_yes, agent_no, status);
