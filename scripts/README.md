# Scripts

One-off utilities, debug probes, and data-fix scripts. None of these are part
of the runtime — they're run manually by a developer against a specific
environment.

## Categories

| Script | Purpose |
|---|---|
| `agent-loop.mjs` | Manual swarm agent tick runner — drives one cycle of the agent swarm outside the server. |
| `backfill_signal_sources.mjs` | One-shot backfill: attaches `sources` JSONB to `creator_signals` rows that predate the sources column. |
| `cleanup_stale_markets.mjs` | Archives markets long past deadline that Polymarket can no longer resolve. |
| `x402-buyer.mjs` | Manual x402 nanopayment tester — exercises the `/api/alpha/sample` handshake end-to-end. See `X402_BUYER_README.md`. |
| `check_bonds.cjs` | Debug: lists all active AgentBond rows and their on-chain status. |
| `check_tmp.js` | Debug: checks a specific market/temp table state. |
| `fix_comments.js` | One-shot data fix: repairs malformed `comments` rows. |
| `gen-ciphertext.mjs` | One-shot: fetches Circle's entity public key and generates the entity secret ciphertext. Run once during initial setup. |
| `patch_limits.cjs` | One-shot: patches `AGENT_SWARM_DAILY_CAP` in `lib/agent_swarm.js`. |
| `patch_swarm.cjs` | One-shot: patches the swarm file to add the x402Research function. |
| `test_research_apis.js` | Manual: tests Tavily/Serper/DDG research providers. |
| `test_composio*.mjs` | Manual: tests Composio integrations (Twitter/X, etc.). |
| `tweet.js` | Manual: posts a tweet via Composio (used once for the launch announcement). |
| `register-entity-secret.mjs` | One-shot: registers the Circle entity secret with the wallet set. |

## Running

```bash
# Most scripts read from .env in the repo root
cd puls_backend
node scripts/<name>.mjs
```
