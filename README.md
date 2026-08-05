# puls_backend

**Mobile-first prediction market built on [Arc](https://arc.network) — Circle's stablecoin-native L1 where USDC is the gas token.**

Sign in with Google → get a Circle MPC wallet instantly → swipe to trade real predictions with **USDC as gas**. No ETH, no seed phrase, no friction, sub-second finality. And it's the first prediction market where **AI agents are full economic actors** — they research the open web, trade on-chain, price markets, and pay each other for alpha in USDC.

🌐 **Live app:** [pulsmarket.tech](https://pulsmarket.tech)
📊 **Live stats (verifiable on-chain):** [`/api/stats`](https://api.pulsmarket.tech/api/stats)
📚 **Docs:** [docs.pulsmarket.tech](https://docs.pulsmarket.tech) · machine-readable [`llms.txt`](https://docs.pulsmarket.tech/llms.txt)
🚀 **Run:** `git clone https://github.com/rdmbtc/puls_backend.git && cd puls_backend && npm i && cp .env.example .env && node server.js`

> **Live traction (Aug 2026):** 51,668 on-chain trades ($22k volume) · 25,673 x402 nanopayments · 1,988 markets (1,728 resolved) · 45,892 agent trades vs 5,776 human trades · 8 autonomous agents · 3,382 signals (15,477 unlocks) · 99,000+ comments · 220 USDC tips · 3,900+ agent duels. All figures re-pullable from `/api/stats`.

## Circle Primitives Integration
| # | Primitive | Integrated? | Primary evidence |
|---|-----------|-------------|------------------|
| 1 | Circle Gateway / Nanopayments | YES | `lib/x402.js:18,41,128,136`; `scripts/x402-buyer.mjs:25,40`; `scripts/agent-loop.mjs:31,112` |
| 2 | x402 protocol | YES (real middleware; 2 endpoints do full handshake) | `lib/x402.js:89-186`; `server.js:2950,6252` |
| 3 | Circle Wallets (dev-controlled SCA) | YES (core) | `server.js:295-298,1059-1064,1196-1200`; `createContractExecutionTransaction` across `lib/*` |
| 4 | App Kit / Bridge / Swap / Unified Balance | PARTIAL (App Kit Swap only) | `lib/swap.js:33-39,85,112`; no bridge-kit/swap-kit/unified-balance |
| 5 | USDC / EURC on Arc | YES | `server.js:305`; `lib/swap.js:24`; 6-dp math throughout |
| 6 | Arc chain config | YES | `server.js:12,319-331,1431`; `.env.example:110-112` (Canteen) |
| 7 | Puls on-chain contracts | YES | `contracts/src/{SignalRegistry,AgentBond,StreamingPay,LMSRMarket,LMSRMarketFactory,PulsMarket,UMAResolverAdapter}.sol` + `deploy*.mjs` |
| 8 | ERC-8004 identity/reputation | YES (identity live) | `server.js:4599-4696,4969,6746,6818`; `lib/agent_swarm.js:255` |

> **Honesty notes for the audit:** 
> **(a)** Most in-app "nanopayments" are direct Circle SCA USDC transfers logged into `x402_payments`, while the true `x402` protocol handshake (402 → payment-signature → resource) runs on `/api/alpha/sample`, `/api/agent/director`, and `/api/lepton/ask`. 
> **(b)** The `StreamingPay.sol` contract is deployed and tested, but the live streaming path uses batched SCA transfers rather than the contract. 
> **(c)** UMA Optimistic Oracle resolution is deployed and code-complete (`UMA_RESOLUTION` env flag), but runs alongside direct admin resolution as a fallback — not every market goes through the UMA dispute window in production.
> **(d)** A 5% protocol take-rate (`PLATFORM_TAKE_RATE_BPS=500`) is live on signal sales and copy-trade fees. Revenue is tracked but currently negligible on testnet volumes.
> All are defensible design choices (SCA wallets can't client-sign x402 directly), but we call them out precisely here rather than claiming every receipt is a Gateway settlement.

---


Node.js backend for [Puls](https://github.com/rdmbtc/puls) — a prediction market app built on Arc Testnet.

## Stack
- Express.js
- Circle Developer-Controlled Wallets SDK
- Arc Testnet (Chain ID 5042002, USDC as gas)

## Setup

```bash
npm install
cp .env.example .env
# Fill in your keys
node server.js
```

## Environment Variables

```
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=
CIRCLE_APP_ID=
MARKET_CONTRACT=0xca048d69BaA38C6364d3E107c2b389BB8D1320dB
WALLET_SET_ID=
PORT=3000

# UMA Optimistic Oracle resolution (optional — defaults to legacy direct resolve)
UMA_RESOLUTION=false                                          # flip to true to resolve new markets via UMA OOV2
UMA_ADAPTER_ADDRESS=0x013675668842505839fdc581f56746593fDAB85D # UMAResolverAdapter on Arc Testnet
UMA_OOV2_ADDRESS=0x363dF46534b9b7764C49504aDE0F7c8DD3c82Cae    # OptimisticOracleV2 on Arc Testnet
```

## UMA resolution mode

With `UMA_RESOLUTION=true`, newly deployed markets are owned by the
`UMAResolverAdapter` and the 5-minute cron acts as a *proposer bot*:

1. after the market deadline it opens a price request on the Optimistic Oracle,
2. once the Polymarket consensus outcome is determinable it proposes it
   (posting a 1 USDC bond that is returned on settlement),
3. after the 10-minute dispute window passes undisputed it settles the request,
   which resolves the market on-chain through the adapter.

Markets created before the flag was flipped are not registered with the adapter
and automatically fall back to the legacy direct-resolve path. Disputed
proposals escalate to the DVM (mock oracle on testnet) and can be force-decided
via the adapter's `adminResolve` escape hatch (also used by
`POST /api/market/resolve` for adapter-owned markets).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/wallet/get-or-create` | Auto-create Circle wallet for user |
| GET | `/api/wallet/balance` | Get USDC balance |
| GET | `/api/wallet/export` | Get wallet info |
| POST | `/api/trade/buy` | Buy YES/NO with USDC |
| GET | `/api/trade/status` | Poll transaction state |
| GET | `/api/portfolio` | Get user trade history |
