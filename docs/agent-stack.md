# Puls × Circle Agent Stack — Runbook

Three swarm agents (**vega**, **atlas**, **nova**) hold their funds in Circle
**Agent Wallets** (user-controlled 2-of-2 MPC) and execute everything — market
trades, signal purchases, blog tips, research snapshots — through the Circle
CLI / Agent Stack pipeline on **ARC-TESTNET**.

## Architecture

```
lib/circle_agent_wallet.js   CLI wrapper (execute/pay/balance/pending/session)
lib/agent_swarm.js           usdcTransferWithMemo(opts.agentKey) → Memo(USDC.transfer)
                             via Agent Wallet; trades via server.js executeAgentTrade
server.js                    executeAgentTrade branch + auto-top-up + watchdog
lib/x402_signals.js          FREE discovery catalog of purchasable signals
```

Money flows routed through Agent Wallets: trades (approve+buyYes/buyNo),
agent→agent signal buys, blog tips, research snapshots (`buyMarketsSnapshot`,
throttled 30 min), ERC-8004 identity mint (opt-in flag).

## Environment

| Var | Meaning |
|---|---|
| `CIRCLE_AGENT_WALLETS` | comma-separated agent keys on Agent Stack |
| `CIRCLE_AGENT_WALLET_ADDRESS_<KEY>` | per-agent wallet address |
| `CIRCLE_AGENT_SESSION_B64` | base64 of `~/.circle-cli/profiles/agent/session.json` |
| `CIRCLE_AGENT_8004_MINT` | `true` = mint ERC-8004 identity from Agent Wallet |
| `AGENT_WALLET_FLOOR_USDC` / `_TARGET_USDC` | auto-top-up trigger / refill level |
| `AGENT_TOPUP_COOLDOWN_H` / `_DAILY_CAP_USDC` | top-up safety limits |
| `AGENT_STALE_PENDING_MS` | watchdog threshold for INITIATED tx age |

## Session refresh (~every 28 days)

The CLI session lives in an ephemeral filesystem — it is restored from
`CIRCLE_AGENT_SESSION_B64` at boot. To refresh:

```bash
circle wallet login you@mail --testnet --init     # → OTP by email
circle wallet login --request <id> --otp <code>
base64 -w0 ~/.circle-cli/profiles/agent/session.json   # → update config var
```

A loud warning fires in logs when expiry is < 3 days.

## Auto-top-up

Every 5 min: balance below `FLOOR` (3 USDC) → treasury transfers up to
`TARGET` (15 USDC). Per-agent cooldown 6 h, global daily cap 60 USDC.
Watchdog: any wallet with an INITIATED tx older than 45 min raises
console.error + Sentry capture.

⚠️ Known Circle constraint: agent wallets execute through a signing-challenge
pipeline; when Circle's signing queue is slow the CLI times out client-side
while the challenge completes later. The wrapper self-polls for 8 min to
absorb this, and a pending-tx guard prevents queue pile-ups. Do NOT remove
the guard — `transaction cancel/accelerate` are not available on ARC-TESTNET.

## Wallet cap

Circle allows **5 agent wallets per account**. Slots: v1 (jammed, retired),
vega-v3, atlas, nova = 4 used… plus one legacy = full. More agents require an
extra Circle account (own email OTP) or a limit increase from Circle.

## Manual ops

```bash
# balances / queues
circle wallet balance --address <w> --chain ARC-TESTNET
circle transaction list --address <w> --chain ARC-TESTNET
# fund from treasury (pattern): scripts pattern in scratch/fund_vega_tmp.mjs
# paid-data smoke test
circle services pay https://api.pulsmarket.tech/api/x402/markets \
  --address <w> --chain ARC-TESTNET
```

## Scaling past 5 wallets

One Circle account = one email = one OTP login = **5 Agent Wallet slots**.
The primary Puls account (ntraid03@gmail.com) is at cap: vega, atlas, nova +
two retired wallets. To onboard the next agent:

1. Provision on a fresh Circle account with the walkthrough script (login >
   create > treasury-fund > print Heroku config lines):

   `ash
   PRIVATE_KEY=<treasury-64-hex> node scripts/provision_agent_wallet.mjs \
     --email agent2@yourdomain.com --key orion --fund 10
   `

2. Key namespaces are per-KEY, not per-account �
   `CIRCLE_AGENT_WALLET_ADDRESS_<KEY>` from any account coexists in one app.

3. Sessions are per-account: the server's `CIRCLE_AGENT_SESSION_B64`
   materializes ONE login profile. A wallet on a second account needs its own
   session profile; until multi-profile support ships, run each account's
   agents in a separate dyno/app or rotate the session var when acting on
   that account's wallets.

See `scripts/provision_agent_wallet.mjs` for flags.
