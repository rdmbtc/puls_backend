# Puls × Circle Agent Marketplace — Listing Pack

Ready-to-paste intake-form text for every Puls paid x402 service.
Target: [Circle Agent Marketplace](https://agents.circle.com/services) · Intake docs: "Become a Seller" / "Get Listed" on developers.circle.com/agent-stack.

## Shared values (same for every service)

| Field | Value |
|---|---|
| **Seller / Provider** | Puls (`pulsmarket.tech`) |
| **Network** | `eip155:5042002` (Arc Testnet) |
| **Settlement asset** | USDC — `0x3600000000000000000000000000000000000000` |
| **Scheme** | `exact` (x402 v2, EIP-3009 vs `GatewayWalletBatched`, Circle Gateway batched settlement) |
| **Payout address** | `0xa93FFcC230d1bd6f6b0a23a7f8BEcc2C9ECD894e` |
| **Payment flow** | GET → 402 + base64 `PAYMENT-REQUIRED` header → retry with base64 `payment-signature` header → 200 + resource + `PAYMENT-RESPONSE` header |
| **Buyer quickstart** | `circle services pay "<endpoint>" --address <AGENT_WALLET> --chain ARC-TESTNET` |

> Before submitting: each service must appear in a live `GET https://api.circle.com/v2/x402/discovery/resources` crawl (the marketplace indexes via the Discovery API). Verify the 402 is returned in <300 ms with a correct `PAYMENT-REQUIRED` header — health-checkers hit it constantly and never pay.

---

## 1. Puls Market Snapshot

- **Name:** Puls Market Snapshot
- **One-liner:** Live prediction-market feed — prices, volume, liquidity and deadlines for top Polymarket-style markets in compact LLM-ready JSON.
- **Category:** `FINANCIAL_ANALYSIS` (tags: prediction-markets, market-data, trading, ai-agents)
- **Method / Endpoint:** `GET https://api.pulsmarket.tech/api/x402/markets?count=20&category=Crypto`
- **Price:** $0.01 per snapshot
- **OpenAPI spec:** https://api.pulsmarket.tech/openapi/x402-markets.json
- **Network / Payout:** eip155:5042002 · `0xa93FFcC230d1bd6f6b0a23a7f8BEcc2C9ECD894e`
- **Description:** Returns up to 50 markets with slug, question, YES/NO prices, volume, liquidity, end date and order-book status. Filter by category. Ideal for agents sizing trades or scanning for mispriced odds.

## 2. Puls Lepton Oracle

- **Name:** Puls Lepton Oracle
- **One-liner:** Ask the Puls AI agent swarm any forecasting question — one lepton ($0.000001), one sharp falsifiable forecast with confidence.
- **Category:** `ARTIFICIAL_INTELLIGENCE` (tags: forecasting, llm, research, ai-agents)
- **Method / Endpoint:** `GET https://api.pulsmarket.tech/api/lepton/ask?q=<question>`
- **Price:** $0.000001 per question (sub-cent floor of the Puls Bazaar)
- **OpenAPI spec:** https://api.pulsmarket.tech/openapi/lepton-ask.json
- **Network / Payout:** eip155:5042002 · `0xa93FFcC230d1bd6f6b0a23a7f8BEcc2C9ECD894e`
- **Description:** Keyless swarm consensus: submit any resolvable forecasting question, get stance, confidence and reasoning backed by live web research. The cheapest useful oracle an agent can buy.

## 3. Puls Alpha Signal

- **Name:** Puls Alpha Signal
- **One-liner:** Flagship house forecast with stance, confidence, thesis and edge vs the crowd.
- **Category:** `FINANCIAL_ANALYSIS` (tags: signals, alpha, prediction-markets)
- **Method / Endpoint:** `GET https://api.pulsmarket.tech/api/alpha/sample`
- **Price:** $0.001 per signal
- **OpenAPI spec:** https://api.pulsmarket.tech/openapi/alpha-sample.json
- **Network / Payout:** eip155:5042002 · `0xa93FFcC230d1bd6f6b0a23a7f8BEcc2C9ECD894e`
- **Description:** The researched flagship forecast from the Puls alpha desk: explicit YES/NO stance, probability, thesis and edge versus market price. One fresh signal per call.

## 4. BTCNode Premium Oracle

- **Name:** BTCNode Premium Oracle
- **One-liner:** Real-time BTC order-book pressure, liquidation-heat proxy and whale alerts from CEX + mempool feeds.
- **Category:** `FINANCIAL_ANALYSIS` (tags: crypto, bitcoin, onchain, trading)
- **Method / Endpoint:** `GET https://api.pulsmarket.tech/api/oracle/btcnode-premium`
- **Price:** $0.000001 per call
- **OpenAPI spec:** https://api.pulsmarket.tech/openapi/oracle-btcnode-premium.json
- **Network / Payout:** eip155:5042002 · `0xa93FFcC230d1bd6f6b0a23a7f8BEcc2C9ECD894e`
- **Description:** Live BTC/USDT price, mempool-driven whale-alert count, liquidation-risk level and aggregate book imbalance. Built to be bought thousands of times a day at nanopayment scale.

## 5. Sugra Macro Intelligence

- **Name:** Sugra Macro Intelligence
- **One-liner:** CPI nowcast and Fed rate-cut odds aggregated from institutional macro feeds.
- **Category:** `FINANCIAL_ANALYSIS` (tags: macro, cpi, fed, rates)
- **Method / Endpoint:** `GET https://api.pulsmarket.tech/api/oracle/sugra-macro`
- **Price:** $0.000005 per call
- **OpenAPI spec:** https://api.pulsmarket.tech/openapi/oracle-sugra-macro.json
- **Network / Payout:** eip155:5042002 · `0xa93FFcC230d1bd6f6b0a23a7f8BEcc2C9ECD894e`
- **Description:** Fed next-meeting cut probability plus a sourced US CPI nowcast (World Bank series). For agents trading rate, inflation and geopolitical-risk markets.

## 6. Polymarket Whale Tracker

- **Name:** Polymarket Whale Tracker
- **One-liner:** Large-position movements and smart-money net flow on Polymarket prediction markets.
- **Category:** `FINANCIAL_ANALYSIS` (tags: whales, smart-money, prediction-markets, flow)
- **Method / Endpoint:** `GET https://api.pulsmarket.tech/api/oracle/polymarket-whales`
- **Price:** $0.000002 per call
- **OpenAPI spec:** https://api.pulsmarket.tech/openapi/oracle-polymarket-whales.json
- **Network / Payout:** eip155:5042002 · `0xa93FFcC230d1bd6f6b0a23a7f8BEcc2C9ECD894e`
- **Description:** Snapshot of smart-money net direction and the largest tracked open position. Follow-the-whale signal for market-making and fading retail crowds.

## 7. Puls Finance Director *(authenticated — optional listing)*

- **Name:** Puls Finance Director
- **One-liner:** Structured, risk-managed prediction portfolio sized to your balance — with a money-back guarantee.
- **Category:** `ARTIFICIAL_INTELLIGENCE` (tags: portfolio, wealth-management, ai-agents)
- **Method / Endpoint:** `POST https://api.pulsmarket.tech/api/agent/director`
- **Price:** $0.50 per plan
- **OpenAPI spec:** https://api.pulsmarket.tech/openapi/agent-director.json
- **Network / Payout:** eip155:5042002 · `0xa93FFcC230d1bd6f6b0a23a7f8BEcc2C9ECD894e`
- **Note:** Combines x402 payment with a Supabase Bearer token (logged-in users). If the intake form requires keyless endpoints only, skip this one; free teaser lives at `GET /api/agent/director/preview`.

## 8. Puls Signals Market *(free discovery listing)*

- **Name:** Puls Signals Market
- **One-liner:** Free discovery catalog of purchasable creator & agent signals — browse on-chain-attested forecasts with price, stance and confidence.
- **Category:** `FINANCIAL_ANALYSIS` (tags: signals, discovery, prediction-markets, catalog)
- **Method / Endpoint:** `GET https://api.pulsmarket.tech/api/x402/signals` (also `GET /api/x402/signals/:id` for one signal)
- **Price:** FREE — discovery only, no payment required
- **OpenAPI spec:** n/a (plain JSON list; per-signal unlocks settle via x402 at the signal's own price)
- **Network / Payout:** eip155:5042002 · unlocks pay the signal's creator (`payTo` resolved per listing) or the treasury for house signals
- **Description:** The index of every signal for sale on Puls: title, market question, stance (YES/NO), confidence, price in USDC and a preview. Agents browse free here, then buy individual unlocks through x402 — creator revenue flows on-chain per unlock. Pair this with the Alpha Signal service (#3) for a ready-made purchase.

> Free listings skip the payment flow entirely: a GET returns the catalog with HTTP 200 — no 402. List it as a $0 discovery entry so agents can find the paid inventory behind it.

---

## Seller-side checklist before submission

1. **402 health:** `curl -si <endpoint>` returns HTTP 402 with a decodable base64 `PAYMENT-REQUIRED` header in <300 ms (no auth, no cookies).
2. **Specs live:** every `/openapi/<name>.json` URL above returns valid JSON (cached 1h).
3. **Discovery visibility:** confirm listings appear under `GET https://api.circle.com/v2/x402/discovery/resources` after intake approval.
4. **Test buy:** run one real `circle services pay` per endpoint from a funded agent wallet; receipts land in `x402_payments` (visible via `GET /api/x402/payments`).
5. **Payout wallet** keeps a small Gateway balance so batched settlement flushes predictably.
