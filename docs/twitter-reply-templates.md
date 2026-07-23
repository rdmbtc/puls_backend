# Puls (@pulsmarket) — Twitter/X Reply Templates

**Purpose:** Standardized, builder-first reply templates for organic Twitter/X community engagement during the Lepton Hackathon.  
**Tone & Style:** Smart, crypto-native, concise, zero hype, strictly compliant with Arc Style Conventions (`onchain`, `@Arc`, clear technical facts, zero financial speculation).

---

## 10 Organic Reply Scenarios

### Scenario 1: Someone asks "What is Puls?"
* **Trigger:** User asks what Puls does or how the platform works.
* **Reply Template:**  
  Puls is an autonomous prediction market built on `@Arc` testnet where AI agents trade 24/7. Agents research mispricings, execute orders using native USDC gas, and pay each other for market intelligence via x402 nanopayments. You can inspect live agent trades and reasoning traces at `pulsmarket.tech/pulse`.

---

### Scenario 2: Someone asks "How do AI agents trade?"
* **Trigger:** Questions about agent mechanics, decision loops, or trading logic.
* **Reply Template:**  
  Each agent runs an autonomous loop: gathering web sources, querying research agents (Sage) via $0.001 USDC x402 nanopayments, and evaluating probability edge. Trades settle on `@Arc` via LMSR market contracts, while AgentBond contracts enforce economic penalties for inaccurate predictions. Live trace: `pulsmarket.tech/agent`.

---

### Scenario 3: Someone praises Arc or Circle
* **Trigger:** Tweets highlighting Arc performance, USDC gas, or Circle infrastructure.
* **Reply Template:**  
  1-second finality and native USDC gas on `@Arc` make high-frequency agent commerce viable. Our 8 autonomous agents have settled 27,000+ trades and 21,000+ x402 nanopayments without managing separate volatile gas tokens. Infrastructure details: `pulsmarket.tech`.

---

### Scenario 4: Someone criticizes testnet ("This isn't real money")
* **Trigger:** Skepticism regarding testnet volume, simulated funds, or demo environments.
* **Reply Template:**  
  Testnet allows testing economic mechanisms under high load before mainnet deployment. Puls contracts enforce real state transitions: 11 verified smart contracts on Arcscan, automated AgentBond slashing, UMA Optimistic Oracle resolution, and 21,000+ x402 nanopayments. Inspect verified contracts: `testnet.arcscan.app/address/0x92c2fd35c0f1a501993be8e0fdae7caa34a8b80b`.

---

### Scenario 5: Someone asks about traction / metrics
* **Trigger:** Inquiries about user count, trade volume, or platform statistics.
* **Reply Template:**  
  Live telemetry on `@Arc` testnet: 27,405 trades settled, $11.06K USDC volume, 1,929 markets deployed, and 21,032 x402 nanopayments processed across 8 active AI agents (all net profitable). Telemetry is verifiable via JSON API: `api.pulsmarket.tech/api/stats`.

---

### Scenario 6: Reply to a Circle post about agent wallets
* **Trigger:** `@BuildOnCircle` or `@Circle` tweeting about programmable wallets or agent autonomy.
* **Reply Template:**  
  Programmable dollars are essential for agent autonomy. In Puls, each AI agent uses developer-controlled wallets to hold USDC, pay for market data via x402 nanopayments, and execute market trades on `@Arc` without manual signing. Live agent PnL: `api.pulsmarket.tech/api/agents/pnl`.

---

### Scenario 7: Reply to a post about prediction markets
* **Trigger:** Discussions around prediction market liquidity, oracle resolution, or LMSR curves.
* **Reply Template:**  
  AI agents solve the liquidity cold-start problem in prediction markets. On Puls, automated agent swarms continuously rebalance odds and provide automated liquidity on `@Arc`, with market resolution handled onchain via UMA Optimistic Oracle V2 contracts. Live market feed: `pulsmarket.tech/pulse`.

---

### Scenario 8: Reply to a post about nanopayments / x402
* **Trigger:** Tweets discussing HTTP 402, micro-transacting, or sub-cent payments.
* **Reply Template:**  
  Sub-cent payments enable machine-to-machine APIs. We implemented x402 headers on `@Arc` where 1 lepton = $0.000001 USDC. Puls AI agents pay $0.001 per intelligence payload, settling over 21,000 nanopayments onchain. Endpoint spec: `api.pulsmarket.tech/api/lepton/info`.

---

### Scenario 9: Reply to a post from Lepton / Canteen
* **Trigger:** Updates or community announcements from `@canteenapp` or Lepton Hackathon organizers.
* **Reply Template:**  
  Building during the Lepton hackathon on `@Arc` testnet. Puls currently runs 8 autonomous AI agents, 100% verified smart contracts on Arcscan, and 21,000+ processed x402 nanopayments. Live dashboard: `pulsmarket.tech/stats`.

---

### Scenario 10: Reply to a post about AI agents in crypto
* **Trigger:** General commentary on AI agents, agentic workflows, or machine economies.
* **Reply Template:**  
  AI agents need verifiable economic boundaries, not just prompt loops. On Puls, agents stake USDC via AgentBond contracts, earn yield for accurate forecasts, face slashing for errors, and transact via x402 nanopayments on `@Arc`. Live decision feed: `pulsmarket.tech/pulse`.
