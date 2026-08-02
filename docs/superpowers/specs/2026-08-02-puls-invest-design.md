# Puls Invest — Real Agent Investment via x402

Date: 2026-08-02
Status: Approved (user + assistant design review)
Scope: puls_backend (API + Neon), invest.pulsmarket.tech (web), Puls Flutter app (sponsorship screen), docs

## Problem

- The Flutter `agent_sponsorship_screen.dart` is a hardcoded single-agent (Pulse) demo: fake APY 47.2%, fake TVL, fake balance "$4,250.00", and "Sign & Delegate" only waits 2.2s — no money moves.
- invest.pulsmarket.tech is a complete marketing site, but its `InvestModal` is a demo: "no funds moved", fake tx hash, hardcoded agent data in `src/lib/agents.ts`.
- Agents are real and profitable on Arc Testnet (see `/api/agents/pnl`: net positive, signal sales, bond returns). We want humans to be able to invest real USDC into agents.

## Goals

1. An investor can pick any of the 8 agents (Vega, Cygnus, Orion, Atlas, Nova, Striker, Sage, Pulse), pay USDC from their own wallet via x402, and own a pro-rata share of that agent's capital pool.
2. Profits are accrued pro-rata from the agent's real PnL (minus 20% performance fee); losses are shared proportionally.
3. The investor can withdraw principal + accrued profit at any time.
4. The same flow works on invest.pulsmarket.tech (web) and in the Flutter app (sponsorship screen rewritten with agent picker).
5. Docs updated to describe the real mechanics.

## Approved Decisions

- **Payment rail:** x402 v2 + Circle Gateway (already production-tested on Arc Testnet: `$0.01` market snapshot endpoint, `x402_payments` receipts in Neon). Payer = investor's EOA (any wallet, via ethers in browser / existing `web3_wallet_bridge` in Flutter, or `x402-client/pay.mjs` for CLI). Payee = treasury seller wallet `0xa93FFcC230d1bd6f6b0a23a7f8BEcC2C9ECD894e` (X402_SELLER_ADDRESS).
- **Share model:** pro-rata share of the agent's capital pool. Pool = agent on-chain balance (from `/api/agents/roster`) + sum of active investments for that agent.
- **Accrual:** `claimable = invested + shareOfNetPnl - performanceFee` where `shareOfNetPnl = (invested / pool) * agentNet`, `performanceFee = 20%` of positive shareOfNetPnl. If agent net is negative, the loss is applied proportionally to the principal (no fee on losses).
- **Withdrawal:** self-serve, anytime. Server sends USDC from treasury to the investor address (treasury key already exists on the server for x402 settle). Recorded in `invest_payouts`.
- **Public reads:** `GET /api/invest/agents` and `GET /api/invest/me?address=` are open (no auth) — display-only. Withdrawal requires auth (existing `apiKeyOrAuth` / signature flow).
- **Scope:** backend + web + Flutter + docs in one pass (user approved "everything at once").

## Data Model (Neon migration)

New migration `migrations/2026-08-02-investments-neon.sql`:

```sql
CREATE TABLE IF NOT EXISTS investments (
  id TEXT PRIMARY KEY,                -- 'inv_' || <x402 payment id>
  payment_id TEXT UNIQUE NOT NULL,    -- id of the x402_payments row that funded it
  investor_address TEXT NOT NULL,
  agent_id TEXT NOT NULL,             -- e.g. 'agent_swarm_striker'
  amount_usdc NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'withdrawn'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invest_payouts (
  id TEXT PRIMARY KEY,                -- 'pay_' || random id
  investment_id TEXT REFERENCES investments(id),
  investor_address TEXT NOT NULL,
  amount_usdc NUMERIC NOT NULL,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

An investment is created **only after** the x402 payment settles (idempotent, keyed on payment_id).

## Backend API (`lib/invest.js`)

Registered in `server.js` alongside the other libs (imports + `registerInvest(app, deps)`).

### `GET /api/invest/agents` (public)
Returns per-agent investment cards:
- From `/api/agents/roster`: agent id, name, role, address, on-chain balance.
- From pnl aggregation (reuse logic from `lib/agent_pnl.js`): net, revenue, isProfitable.
- Computed: `pool` (balance + active investments), `tvl` (= pool), `winRate` if available from roster, and a derived `apyEstimate` (net / pool annualized — honest, labeled as estimate, or omitted if pool is 0).
- **Agent identity normalization:** the roster uses its own agent ids/keys while pnl aggregation keys on `creator_user_id` (`agent_%` prefix, e.g. `agent_swarm_striker`). The invest module must resolve a single canonical `agent_id` per agent across roster + pnl (verify the roster exposes the same ids; if not, map by name/address in one place and document the mapping).

### `GET /api/invest/{agentId}?amountUsdc=5` — paywalled endpoint (public)
- Standard x402 pattern (same as `GET /api/x402/markets`): without a payment signature it returns **402** with the payment-required payload (`resource.url = /api/invest/{agentId}`, `price = amountUsdc`); with a valid payment signature the middleware settles and the handler returns the agent card + the investor's new position summary.
- Any x402 client can pay it directly: our `pay.mjs`, the browser wallet flow, or Circle CLI (`circle services pay --address <EOA> --chain ARC-TESTNET "https://api.pulsmarket.tech/api/invest/striker?amountUsdc=5"`).
- Validation: agentId must exist in the roster; amount must be `>= 0.01`, `<= 1000`, max 2 decimals.
- Requires a **dynamic price** variant of the existing `x402Paywall` middleware in `lib/x402.js` (extend with a `price(req)` hook — `buildPaymentRequirements` already accepts an arbitrary price).

### Settlement hook
- In `lib/x402.js` after a successful settle + `x402_payments` insert: if the recorded `endpoint` matches `^/api/invest/([^/?]+)`, create the `investments` row (agentId from the path, payer from settle, amount from payment) — best-effort, non-blocking, idempotent on `payment_id` (ON CONFLICT DO NOTHING).

### `GET /api/invest/me?address=` (public)
For each agent: invested total, pool share, accrued net (pro-rata of agent net, with 20% fee), claimable amount, per-investment rows (id, amount, status, created_at).

### `POST /api/invest/withdraw` (authed)
Body: `{ agentId, amountUsdc? }` (or `{ investmentId }` — decide in implementation; default = claimable for the agent).
- Auth via existing `apiKeyOrAuth`/`authenticateUser`; the authenticated address must match `investor_address` of the investments being withdrawn.
- Computes claimable (same formula as `me`), sanity-checks treasury balance (`X402_SELLER` wallet), sends USDC via the existing treasury signer to the investor address, records `invest_payouts`, marks investments `withdrawn` (full withdraw per agent — MVP; partial withdraw can be added later).
- Return: `{ txHash, amountUsdc, claimableAfter }`.

### Concurrency/idempotency
- Payments settle exactly once (x402 verify + settle already guards). `investments.payment_id` is UNIQUE — a duplicate settle cannot double-credit.
- Withdrawals: serialize per investor+agent with a lock or transaction to avoid double-spend of claimable (implementation detail — a `SELECT ... FOR UPDATE` on the investment rows or a pessimistic in-process mutex; volume is tiny on testnet).

## Web — invest.pulsmarket.tech

- Replace the demo `InvestModal` submit path with a real flow:
  1. "Connect wallet" — ethers v6 + injected provider (MetaMask) + Arc Testnet chain config (chain 5042002, USDC `0x3600...`, RPC from backend info). No wallet installed → show the Circle CLI fallback instructions (copy-paste `circle services pay` command with `--address` + `--chain ARC-TESTNET`).
  2. Pick agent → amount → "Invest via x402": hit `GET /api/invest/{agentId}?amountUsdc=X` → parse the 402 `PAYMENT-REQUIRED` payload → client-side `approve` USDC to Gateway wallet, sign+submit Gateway settle tx (same math as `x402-client/pay.mjs`, ported to TS with ethers). Gas paid in USDC (Arc). Then retry the request with the payment signature to get the confirmation.
  3. Success screen with real tx hash + arcscan link + position summary.
- Data: agent cards fetch `GET /api/invest/agents` (fallback to static `src/lib/agents.ts` when offline).
- New section "My investments": enter address → `GET /api/invest/me` → positions list + "Withdraw" (calls `/api/invest/withdraw` with the signed wallet).
- Keep existing design language; add honest disclaimer: testnet, illustrative APY, fee 20%.

## Flutter — `agent_sponsorship_screen.dart` (rewrite)

- Add agent picker at top (horizontal grid / bento like the web site): 8 agents from `GET /api/invest/agents` (name, glyph, winRate, TVL, address, net).
- Selected agent feeds the existing UI (header, stat chips, performance chart, amount slider, profit split) with **real** values; chart curve stays a visual affordance but is labeled as historical illustration, anchored to real net.
- "Sign & Delegate" → real x402 payment using the existing `web3_wallet_bridge` (web build) / wallet service: hit the paywalled endpoint, approve USDC, settle via Gateway. Show real tx + link.
- "My investments" view: `GET /api/invest/me` for connected address + withdraw action.
- Non-web platforms (iOS/Android stubs): show "open invest.pulsmarket.tech" fallback rather than faking success.

## Docs

- Update `docs/agents/sponsorship.mdx` (in the docs repo): real mechanics (x402, pool share, 80/20 split, withdraw), API reference for the new endpoints, and a "how to invest" section (web, app, Circle CLI) for judges.
- Note on the docs page: TVL/pools are testnet-scale; projections are estimates, not promises.

## Testing & Rollout

1. Unit/lightweight tests: pool math, claimable math (positive/negative net, fee, zero pool), paywall amount validation.
2. E2E (like the market-snapshot test): `x402-client/pay.mjs` against `GET /api/invest/{agentId}?amountUsdc=0.01` → verify `investments` row in Neon (via `/api/invest/me?address=`) → verify treasury received USDC.
3. Withdraw E2E: call `/api/invest/withdraw` (authed) → verify `invest_payouts` row + on-chain transfer + `claimableAfter = 0`.
4. Deploy to Heroku (prod), update docs site, verify on docs.pulsmarket.tech.
5. Demo for judges: invest via Circle CLI (`circle services pay --address <EOA> --chain ARC-TESTNET`), show receipt, show position, show withdraw tx.

## Out of Scope (MVP)

- Smart-contract vault / trustless delegation (later).
- Partial withdrawal, auto-reinvestment, compounding rounds.
- Circle Smart Wallet as a first-class payer (x402 any-wallet covers it; SCW later).
- Multi-collateral (USDC only).
