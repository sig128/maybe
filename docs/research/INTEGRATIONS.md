# MAYBE: integration facts for engineers

Research date: **2026-11-04**. Every URL below was accessed on 2026-11-04.

**Marking rules**
- Each fact carries a source ID from the index in section 1, or is marked **UNVERIFIED**.
- Lines starting with **Assessment** are my reasoning from the cited facts, not vendor statements.

**How sources were read**
- **GitHub content was read directly from the files:** the Pump docs and IDLs, and the Jupiter example repos.
- **Web docs went through a fetch tool** that extracts text with a model. Spot-check any quoted string from a web doc against the live page before hard-coding it.
- **No RPC access was available**, so no on-chain account was inspected.

---

## 0. What most affects architecture

| Integration | Read without credentials? | Eligibility / geo | Can a program-controlled Solana vault execute it? |
|---|---|---|---|
| Polymarket | Yes. Gamma, CLOB market data and Data API are public [PM1][PM5][PM10] | Close-only (no new positions) for US and 37 other listed countries/regions; fully blocked in 7 [PM7] | **No.** Markets live on Polygon with pUSD collateral and signed off-chain orders. Read-only signal [PM12][PM13] |
| Kalshi (direct REST) | Yes for market data [K1] | Not researched for direct trading | **No.** Account-based off-chain exchange. Read-only signal |
| DFlow (tokenized Kalshi on Solana) | Dev hosts: yes, rate-limited and "intended for testing only". Prod: needs `x-api-key` [D9] | US and about 50 jurisdictions must be geoblocked; the **receiving wallet must be KYC-verified via Proof** [D6][D7] | **No for buying.** Proof links wallets by signed message, and `/order` returns a transaction for the user to sign [D3][D8]. Read-only signal |
| Jupiter Prediction API | Keyless at 0.5 req/s [J11] | Blocks US and South Korea IPs [J11] | Not documented. Positions are PDAs owned by the user wallet [J11] |
| Pump bonding curve / PumpSwap | n/a (on-chain) | n/a | **Yes, with caveats.** CPI is documented [P9]. SOL-paired paths move native lamports from `user` (section 7.7) |
| Jupiter Swap | n/a | n/a | **Yes, via the `/build` (Router/Metis) path only.** "CPI use cases must use the Router" [J1]. Many constraints (section 8.4) |

**Assessment:** the vault should treat prediction markets as **read-only triggers**. It should execute only Solana swaps (Jupiter `/build` or Pump direct), and accept resolution through a signed attestation verified with the Ed25519 precompile (section 9.4). It should not hold venue positions.

---

## 1. Source index

**Polymarket**
| ID | URL |
|---|---|
| PM1 | https://docs.polymarket.com/market-data/discover-markets.md |
| PM2 | https://docs.polymarket.com/market-data/market-details.md |
| PM3 | https://docs.polymarket.com/market-data/prices-order-books.md |
| PM4 | https://docs.polymarket.com/api-reference/markets/get-market-by-id.md |
| PM5 | https://docs.polymarket.com/api-reference/market-data/get-order-book.md |
| PM6 | https://docs.polymarket.com/api-reference/rate-limits.md |
| PM7 | https://docs.polymarket.com/api-reference/geoblock.md |
| PM8 | https://docs.polymarket.com/concepts/negative-risk.md |
| PM9 | https://docs.polymarket.com/concepts/resolution.md |
| PM10 | https://docs.polymarket.com/api-reference/markets/get-resolution-state.md |
| PM11 | https://docs.polymarket.com/concepts/markets-events.md |
| PM12 | https://docs.polymarket.com/concepts/pusd.md |
| PM13 | https://docs.polymarket.com/migrate/polymarket-v2/overview.md |

**Kalshi**
| ID | URL |
|---|---|
| K1 | https://docs.kalshi.com/getting_started/quick_start_market_data.md |
| K2 | https://docs.kalshi.com/api-reference/market/get-market.md |
| K3 | https://docs.kalshi.com/getting_started/market_lifecycle.md |
| K4 | https://docs.kalshi.com/getting_started/rate_limits.md |
| K5 | https://docs.kalshi.com/llms.txt (index) |

**DFlow**
| ID | URL |
|---|---|
| D1 | https://pond.dflow.net/prediction-markets/introduction |
| D2 | https://pond.dflow.net/prediction-markets/recipes/quickstart |
| D3 | https://pond.dflow.net/prediction-markets/recipes/buy-outcome-tokens |
| D4 | https://pond.dflow.net/prediction-markets/recipes/redeem-outcome-tokens |
| D5 | https://pond.dflow.net/build/recipes/prediction-markets/monitor-market-lifecycle |
| D6 | https://pond.dflow.net/prediction-markets/kyc.md |
| D7 | https://pond.dflow.net/prediction-markets/prediction-market-compliance.md and https://pond.dflow.net/learn/prediction-markets |
| D8 | https://pond.dflow.net/proof/partner-integration.md and https://pond.dflow.net/proof/introduction.md |
| D9 | https://pond.dflow.net/get-started/endpoints.md |
| D10 | https://pond.dflow.net/get-started/api-key.md |
| D11 | *Secondary source:* https://www.quicknode.com/guides/solana-development/3rd-party-integrations/kalshi-prediction-markets-with-dflow (page says updated 2026-10-21) |
| D12 | https://phantom.com/prediction-markets |

**Jupiter**
| ID | URL |
|---|---|
| J1 | https://developers.jup.ag/docs/swap/index.md (https://dev.jup.ag redirects to developers.jup.ag/docs) |
| J2 | https://developers.jup.ag/docs/swap/build/index.md |
| J3 | https://developers.jup.ag/docs/api-reference/swap/build.md |
| J4 | https://developers.jup.ag/docs/swap/migration/metis-to-build.md |
| J5 | https://developers.jup.ag/docs/swap/build/common-instructions.md |
| J6 | https://developers.jup.ag/docs/portal/rate-limits.md |
| J7 | https://developers.jup.ag/docs/swap/advanced/transaction-versions.md |
| J8 | https://github.com/jup-ag/jupiter-cpi (commit `12bc5f6`, 2024-01-10): `src/lib.rs`, `idl.json` |
| J9 | https://github.com/jup-ag/jupiter-cpi-swap-example (commit `b9bdc57`, 2025-02-09) |
| J10 | https://github.com/jup-ag/sol-swap-cpi (README) |
| J11 | https://developers.jup.ag/docs/prediction/index.md |
| J12 | https://developers.jup.ag/docs/get-started/development-basics.md |
| J13 | https://jup.ag and https://jup.ag/prediction/POLY-32225 (UI observed 2026-11-04) |

**Pump**: https://github.com/pump-fun/pump-public-docs (commit `639b87f`, 2026-10-13)
| ID | File |
|---|---|
| P1 | `README.md` |
| P2 | `docs/PUMP_PROGRAM_README.md` |
| P3 | `docs/PUMP_SWAP_README.md` |
| P4 | `docs/instructions/COIN_CREATION.md` |
| P5 | `docs/instructions/TRADE_V3.md` |
| P6 | `docs/instructions/PUMP_SWAP_TRADE_V2.md` |
| P7 | `docs/instructions/BUY.md` and `SELL.md` |
| P8 | `docs/instructions/MULTI_HOP_SWAP.md` |
| P9 | `docs/CPI_README.md` |
| P10 | `docs/FEE_PROGRAM_README.md` and `docs/fees.png` |
| P11 | `docs/FEE_RECIPIENTS.md` |
| P12 | `docs/BREAKING_FEE_RECIPIENT.md` |
| P13 | `docs/FAQ.md` |
| P14 | `idl/pump.json`, `idl/pump_amm.json`, `idl/pump_fees.json` |

**Solana**
| ID | URL |
|---|---|
| S1 | https://solana.com/docs/rpc.md |
| S2 | https://solana.com/developers/cookbook/transactions/confirmation.md |
| S3 | https://solana.com/docs/core/transactions/durable-nonces.md |
| S4 | https://solana.com/docs/core/programs/precompiles.md |
| S5 | https://solana.com/docs/core/instructions/instruction-introspection.md |
| S6 | https://solana.com/docs/core/transactions/versioned-transactions.md |
| S7 | https://solana.com/docs/core/constants-reference.md |
| S8 | https://solana.com/docs/tokens/extensions.md |
| S9 | https://solana.com/docs/tokens/extensions/transfer-fees.md |
| S10 | https://solana.com/docs/tokens/extensions/transfer-hook.md |
| S11 | https://solana.com/docs/tokens/extensions/permanent-delegate.md |
| S12 | https://solana.com/docs/tokens/extensions/default-state.md |
| S13 | https://solana.com/docs/tokens/extensions/pausable.md |
| S14 | https://solana.com/docs/tokens/extensions/cpi-guard.md |
| S15 | https://solana.com/docs/tokens/extensions/memo-transfer.md |
| S16 | https://solana.com/docs/core/cpi/cpi-with-pda |

---

## 2. Polymarket

### 2.1 Chain, collateral, auth
- **Chain and collateral.** pUSD is an ERC-20 on Polygon, backed by USDC, and is "the collateral token used for all trading on Polymarket" [PM12].
- **Protocol V2.** It "introduces new position tokens and contracts". Existing CTF (v1) holdings are not converted [PM13].
- **Gamma API** (base `https://gamma-api.polymarket.com`): "This data is public and does not require authentication." [PM1]
- **CLOB** (`https://clob.polymarket.com`): `GET /book` has `security: []`, i.e. no auth [PM5].
- **Data API** (`https://data-api.polymarket.com`): "All data routes are public; no API key or token is required." [PM10]

### 2.2 Endpoints (read)

**Gamma** [PM1][PM4]
- `GET /markets/{id}`, `/markets/slug/{slug}`, `/markets/keyset`
- `GET /events/{id}`, `/events/slug/{slug}`, `/events/keyset`
- `GET /public-search?q=`, `/tags`, `/series`
- Pagination: pass the response's `next_cursor` as `after_cursor`.
- `closed`: omitted or `false` returns open items; `true` returns closed; `any` requires an identifier filter. `tag_id` filters by tag.
- `version`: `v1` (CTF) or `v2`, repeatable. **It defaults to v1**, so pass `version=v1&version=v2` or V2 markets are missed [PM1].
- `resolution_status`: `inactive|active|resolved` (V2 markets) [PM1].

**CLOB** (base `https://clob.polymarket.com`) [PM3]
- `GET /book?token_id=` and `POST /books`
- `GET /price?token_id=&side=` and `POST /prices`
- `GET /midpoint` and `POST /midpoints`
- `GET /spread` and `POST /spreads`
- `GET /last-trade-price` and `POST /last-trades-prices`
- Batch endpoints accept at most 500 items [PM3].
- `/book` returns `market, asset_id, timestamp, hash, bids[{price,size}], asks[...], min_order_size, tick_size, neg_risk, last_trade_price` [PM5].
- Whether `side=BUY` on `/price` returns the best bid or the best ask: **UNVERIFIED**; test before use.

**Data API**
- Price history: `GET https://data-api.polymarket.com/v2/prices-history`, with `token_id` plus exactly one of `interval`, `start` or `as_of` [PM3].
- Resolution: `GET https://data-api.polymarket.com/v2/resolutions`, with exactly one of `question_id`, `condition` (up to 20) or `event_id` (up to 20) [PM10].

### 2.3 Rate limits
- Sliding windows, IP-based, enforced by Cloudflare. Excess requests are "throttled (delayed/queued) rather than immediately rejected" [PM6].
- Note that `/v2/resolutions` documents `429` with `Retry-After` [PM10].

| API | Limit per 10 s [PM6] |
|---|---|
| Gamma, general | 4,000 |
| Gamma `/markets` | 300 |
| Gamma `/events` | 500 |
| Gamma `/public-search` | 350 |
| CLOB `/book` | 1,500 |
| CLOB `/books` | 500 |
| CLOB `/price` | 1,500 |
| CLOB `/midpoint` | 1,500 |
| CLOB `/prices-history` | 1,000 |
| Data API v2, general | 800 |
| Data API `/v2/prices-history` | 200 |

### 2.4 Fields to map
- **IDs:** Gamma market `id` (integer) and `conditionId`; `questionID`; `slug`; `version` [PM4].
  - Outcome token IDs: `clobTokenIds` for v1 markets (examples `JSON.parse` it) and `positionIds` (an array) for v2 [PM2].
  - That index *i* of the token IDs aligns with `outcomes[i]`: **UNVERIFIED**.
- **Question and rules:** `question`, `description`, `resolutionSource` [PM4].
- **Outcomes and prices:** `outcomes` and `outcomePrices` ("JSON-encoded strings") [PM2]; `bestBid`, `bestAsk`, `spread`, `lastTradePrice` [PM4].
- **Volume and liquidity:** `volumeNum`, `volume24hr`, `liquidityNum` (plus string variants `volume`, `liquidity`) [PM4].
- **Dates:** `endDate`, `endDateIso`, `umaEndDate`, `closedTime` [PM4].
- **Status:** `active`, `closed`, `archived`, `acceptingOrders`, `restricted`, `automaticallyResolved`, `umaResolutionStatus`, `umaResolutionStatuses` [PM4]. The meaning of `restricted`: **UNVERIFIED**.
- **Neg risk:** `negRisk` and `negRiskMarketID` are on the Event schema, not on Market. Market has `negRiskOther`. The Event trading config has `enableNegRisk` and `negRiskAugmented` [PM2][PM4].
- **Resolution rows** (Data API) [PM10]:
  - `status` ∈ `initialized, posed, proposed, challenged, reproposed, disputed, resolved`; condition rows can also be `active` or `arbitration`
  - `payouts` = integer array `[outcome0, outcome1]` "in micro-USDC per share"
  - `market_type` ∈ `BINARY, INCREMENTAL_NEGRISK, ATOMIC_NEGRISK`
  - `reporter` ∈ `UMA_OO, CHAINLINK, EOA`
  - also `was_disputed`, `resolved_at`, `expected_settlement_time`

### 2.5 Market types and binary compatibility
- **Every market is binary.** "Each market represents a resolvable condition with Yes and No outcomes." Events group markets [PM11].
- **Neg-risk events** are multi-outcome with only one winner. A No share "can be converted into 1 Yes share in every other market" [PM8].
- **Augmented neg risk** adds placeholder and "Other" outcomes. "Placeholder outcomes should be ignored until they are named or until resolution occurs." The definition of "Other" shifts over time [PM8].
- **Up/Down markets** resolve from a "Chainlink TWAP stream" [PM9].
- **Combos and combinatorial positions** exist: docs index pages `trading/combos/*` and `trading/positions/combinatorial.md`; not researched.
- **Assessment:** for IF/THEN, allow any single named market's YES outcome, including a named outcome of a neg-risk event. Exclude placeholders, "Other" and combos. Treat a 50/50 result as "OTHERWISE".

### 2.6 Resolution and settlement
- **Oracle.** Prediction markets use the UMA Optimistic Oracle [PM9].
  - The proposal bond is "typically" $750 pUSD, with a **2-hour challenge period**.
  - Disputes escalate; a second dispute goes to UMA's DVM vote of about 48 h. Undisputed markets settle about 2 h after proposal; disputed ones take 4–6 days [PM9].
- **Outcomes.** A "Too Early" ruling is possible. Unknown/50-50 is "rare": "each token redeems for $0.50". Winning tokens redeem for $1.00 [PM9].
- **Cancelled or voided markets** are not described on the page (**UNVERIFIED** how they surface). Map them via Data API `payouts` when present.

### 2.7 Eligibility and geo [PM7]
- **Check endpoint:** `GET https://polymarket.com/api/geoblock` returns `{blocked, ip, country, region}`. "Before placing orders, builders should verify the location."
- **Blocked completely:** IR, SY, CU, KP, and the UA-43, UA-14 and UA-09 regions.
- **Close-only on frontend and API:** AR, AU, BY, BE, BI, BR, CA-BC, CA-ON, CA-AB, CA-QC, CF, CD, ET, FR, DE, IQ, IT, LB, LY, MM, NZ, NI, KP, PL, RU, SG, SO, SK, SS, SD, TW, TH, GB, **US**, UM, VE, YE, ZW.
- **Close-only on frontend only:** IE, JP, MT (sports), NL, KR.
- **Reading market data** is not restricted by the page (it addresses order placement only); **UNVERIFIED** beyond that.

### 2.8 Can a program-controlled Solana vault execute?
**Assessment: no.** Positions are Polygon tokens settled in pUSD [PM12][PM13]. Orders are signed off-chain, and V2 uses an ExchangeV3 signing domain [PM13]; a Solana PDA cannot produce those signatures. The US is close-only [PM7]. Use Polymarket only as a resolution and odds signal.

---

## 3. Kalshi (direct REST, read-only)

**Hosts**
- Production: `https://external-api.kalshi.com/trade-api/v2`. Also supported: `https://api.elections.kalshi.com/trade-api/v2`.
- Demo: `https://external-api.demo.kalshi.co/trade-api/v2` [K2].

**Auth**
- "No authentication headers are required for the endpoints in this guide." [K1]
- `GET /markets/{ticker}` has `security: []` [K2].

**Endpoints** [K1][K2]
- `GET /series/{series_ticker}`
- `GET /events/{event_ticker}`
- `GET /markets?series_ticker=&status=`
- `GET /markets/{ticker}`
- `GET /markets/{ticker}/orderbook`: "The API only returns bids (not asks)." Response is `orderbook_fp.yes_dollars` / `no_dollars` arrays.
- A "Get Trades" page exists [K5]; its path is **UNVERIFIED**.

**Rate limits**
- Token budgets per tier for authenticated traffic, in read tokens per second: Basic 200, Advanced 300, Expert 600, Premier 1,200, Paragon 2,400, Prime 4,800, Prestige 12,000 [K4].
- Limits for unauthenticated reads: **UNVERIFIED**.

**Fields** [K2]
- **IDs and titles:** `ticker`, `event_ticker`, `market_type` ∈ `binary|scalar`, `yes_sub_title`, `no_sub_title` (`title` and `subtitle` are deprecated).
- **Times:** `open_time`, `close_time`, `expected_expiration_time`, `latest_expiration_time`, `settlement_timer_seconds`.
- **Prices** are fixed-point **dollar strings**: `yes_bid_dollars`, `yes_ask_dollars`, `no_bid_dollars`, `no_ask_dollars`, `last_price_dollars`. There are no cents fields.
- **Volume:** `volume_fp`, `volume_24h_fp`, `open_interest_fp`. There is no liquidity field.
- **Result and settlement:** `result` ∈ `'yes' | 'no' | scalar | ''`, `settlement_value_dollars`, `settlement_ts`.
- **Rules:** `rules_primary`, `rules_secondary`, `can_close_early`, `early_close_condition`.
- **Strikes:** `strike_type`, `floor_strike`, `cap_strike`.
- **Combos:** `mve_collection_ticker`, `mve_selected_legs`.

**Lifecycle** [K3]
- `status` ∈ `initialized, active, inactive, closed, determined, disputed, amended, finalized`.
- Filter aliases: `unopened|open|paused|closed|settled`.
- After a result: "A settlement timer then runs for `settlement_timer_seconds`", during which the result may be disputed. `finalized` is terminal, with `settlement_ts` set.
- Close time "May be moved earlier if `can_close_early` is true."
- Void outcomes are not described (**UNVERIFIED**).

**Binary-compatible:** `market_type=binary` without MVE fields. Act only on `finalized` [K3].

**Vault executability. Assessment: no.** Kalshi is an off-chain exchange. Trading uses Kalshi accounts and API keys (key docs exist at https://docs.kalshi.com/getting_started/api_keys.md; not read in detail).

---

## 4. DFlow (Kalshi tokenized on Solana)

**What it is**
- "DFlow tokenizes Kalshi prediction markets on Solana." "Each outcome becomes an SPL token that users buy, sell, and redeem" [D1].
- Phantom's prediction markets use it: DFlow "sources event data, including outcome data, from Kalshi's database" [D12].
- The token program of the outcome mints (SPL vs Token-2022) is **UNVERIFIED**; the D11 sample code queries both.

**Hosts** [D2][D9]
| Service | Dev | Prod |
|---|---|---|
| Trade API | `https://dev-quote-api.dflow.net` | `https://quote-api.dflow.net` |
| Trade API WebSocket (paths `/quote-stream`, `/book-stream`, `/priority-fees/stream`) | `wss://dev-quote-api.dflow.net` | `wss://quote-api.dflow.net` |
| Metadata API | `https://dev-prediction-markets-api.dflow.net` | hostname **UNVERIFIED** |
| Proof | `https://proof.dflow.net` | same |

**Auth and limits** [D9][D10]
- Dev: no key, rate-limited, "intended for testing only".
- Prod: an API key is required, sent as `x-api-key`. Keys come via a form, with a response in "2-5 days". Numeric limits are not stated.

**Endpoints** [D2][D4][D5][D11]
- **Metadata:**
  - `GET /api/v1/events?withNestedMarkets=true&seriesTickers=&status=active`
  - `GET /api/v1/markets?status=&limit=`
  - `GET /api/v1/market/by-mint/{mint}`
  - `POST /api/v1/markets/batch`
  - `POST /api/v1/filter_outcome_mints`
  - `GET /api/v1/series?category=&tags=`
  - `GET /api/v1/tags_by_categories`
- **Trade:**
  - `GET /order?userPublicKey&inputMint&outputMint&amount` (buy, sell and redeem)
  - `GET /order-status?signature=` (D11 adds `&lastValidBlockHeight=`)
- **Proof:** `GET https://proof.dflow.net/verify/{address}` → `{verified}`. Public endpoint [D8].

**Fields** (D11 is secondary; confirm against the API)
- `ticker`, `title`, `yesSubTitle`, `noSubTitle`, `status`, `result`, `openTime`, `closeTime`, `yesBid`, `yesAsk`, `noBid`, `noAsk`, `eventTicker`.
- `accounts[settlementMint]` holds `marketLedger`, `yesMint`, `noMint`, `isInitialized`, `redemptionStatus`, and a scalar percentage field.
- That field's name differs between sources: `scalarOutcomePct` in [D4] vs `scalarOutcomePercent` in [D11]. **UNVERIFIED** which is correct.
- Volume and open-interest field names: **UNVERIFIED**.

**Lifecycle and settlement**
- "initialized → active → inactive → closed → determined → finalized" [D5].
- Redeem only when `status` is `determined` or `finalized` **and** `redemptionStatus` is `"open"` [D2][D4].
- Redemption needs funding moved "from the Settlement Vault to the Redemption Vault" [D4].
- A `result` of `""` or `"scalar"` (e.g. a cancelled event) makes both sides partially redeemable. YES pays `pct/10000` and NO pays `(10000-pct)/10000` [D4].

**Execution model**
- Use USDC or CASH as `inputMint` to buy directly; other tokens add a swap leg. "Contracts can't be bought fractionally." [D3]
- The first trade into a market that has not been tokenized yet costs about 0.02 SOL [D3].
- Orders are async. D11 says "Concurrent Liquidity Program": an intent transaction is submitted and fills arrive in separate transactions; poll `/order-status` until closed [D11, secondary].

**KYC and geo**
- "The wallet receiving the outcome tokens must be verified." Unverified wallets get an error from `/order` on buys; "Unverified wallets can still sell" [D6].
- Enforcement is described **only at the `/order` API level**. Nothing on-chain (hook or allowlist) is described [D6].
- "Access must be blocked from the United States and the following jurisdictions": about 50 countries, including CA, GB, FR, AU, SG, TW, TH, CN, RU and AE, plus sanctioned regions. "Failure to comply may result in enforcement actions, including revocation of API access." [D7]
- Proof verification links a wallet by having the user sign `Proof KYC verification: {timestamp}` [D8].

**Vault executability. Assessment: no.**
- A PDA cannot sign the Proof message, so it cannot become a "verified" receiving wallet [D8].
- `/order` returns a whole transaction for `userPublicKey` to sign, not CPI-able instructions [D3].
- Moving tokens into a vault after a KYC'd purchase would sidestep the receiving-wallet KYC rule, which is a compliance risk. Don't.
- Use DFlow and Kalshi status/result as a read-only trigger. The on-chain `marketLedger` account could in future let the vault read results directly; its program ID and layout are **UNVERIFIED**.

---

## 5. Jupiter Prediction API (seen on jup.ag)
- **Base and endpoints** [J11]: `https://api.jup.ag/prediction/v1`.
  - Discovery: `/events`, `/markets/{marketId}`, `/orderbook/{marketId}`
  - Trading: `POST /orders`, `POST /execute`, `DELETE /positions`
  - Claims: `POST /positions/{positionPubkey}/claim`
- **Auth:** keyless requests are "limited to 0.5 requests per second"; use `x-api-key` in production [J11].
- **Geo:** "We have restricted United States and South Korea IPs from accessing the Prediction Market API." [J11]
- **Positions** are a "PDA derived from owner, market, and side", not tokens. The exception is Jupiter Forecast: "Each side is a Token-2022 mint". Orders are funded in JupUSD or USDC [J11].
- **Venue:** event IDs use a `POLY-` prefix (e.g. `POLY-32225`) [J13], and the docs say the API is provider-agnostic. That the markets are Polymarket-sourced is **UNVERIFIED**.
- **Assessment:** not usable by a PDA vault. Users sign, and no CPI interface is documented.

## 6. Canonical market model (cross-venue mapping)

| MAYBE field | Polymarket | Kalshi | DFlow |
|---|---|---|---|
| `venue_market_id` | `id` + `conditionId` | `ticker` | `ticker` (+ outcome mints) |
| `question` | `question` | event title + `yes_sub_title` | `title`, `yesSubTitle` |
| `yes_ref` | token ID per `version` | `ticker` + side `yes` | `accounts[mint].yesMint` |
| `bid` / `ask` | `bestBid` / `bestAsk`, or CLOB `/book` | `yes_bid_dollars` / `yes_ask_dollars` | `yesBid` / `yesAsk` |
| `spread` | `spread` | derived | derived |
| `volume` / `liquidity` | `volumeNum`, `volume24hr` / `liquidityNum` | `volume_fp`, `open_interest_fp` / none | UNVERIFIED |
| `end_time` | `endDate` | `close_time` (+ `can_close_early`) | `closeTime` |
| `rules`, `resolution_source` | `description`, `resolutionSource` | `rules_primary/secondary` | UNVERIFIED |
| `status` | `active/closed/archived` + Data API `status` | 8-value `status` | 6-value `status` |
| `final_outcome` | Data API `payouts` on `resolved` | `result` once `finalized` | `result` (+ scalar pct) once `determined/finalized` |
| `void_or_split` | 50/50 → `[0.5,0.5]` payouts | `scalar` | `""`/`"scalar"` |

**Assessment:** "OTHERWISE" fires for a NO result, 50/50, scalar or void, and when no final state is reached by the rule's BEFORE deadline.

---

## 7. Pump (bonding curve + PumpSwap)

### 7.1 Program IDs (exact)
- **Pump (bonding curve):** "Pump program is deployed at address `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` on both Mainnet and Devnet" [P2].
- **PumpSwap (AMM):** "a constant-product AMM deployed at address `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`" [P3].
- **Pump Fees:** `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` (IDL `address`) [P14].
- **Mayhem:** `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` [P4].
- **Known accounts:**
  - Pump `Global` `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`, seeds `["global"]` [P2]
  - PumpSwap `GlobalConfig` `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw`, seeds `["global_config"]` [P3]
  - Pump `fee_config` `8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt` [P5]
  - PumpSwap `fee_config` `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` [P6]
  - Pump `event_authority` `Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1` [P8]
- **PDAs:**
  - bonding curve `["bonding-curve", mint]` [P2]
  - pool `["pool", index, creator, baseMint, quoteMint]`; migrated pools use index 0 [P3]
  - `user_volume_accumulator` `["user_volume_accumulator", user]`, defined in both programs [P5][P6]

### 7.2 Token program used by coins
- **`create_v2` (current):** "`mint`: New Token-2022 mint account. Signer, initialized with `decimals = 6`, `mint_authority`, `token_program`, and metadata pointer set to `mint`." [P4]
  - `token_program` = "Token-2022 Program: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`" [P4]
  - The IDL doc reads "Creates a new spl-22 coin and bonding curve." [P14]
- **Legacy `create`:** still present in the IDL. It uses `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` plus Metaplex metadata (`metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`) [P14].
  - Trade docs: "Token-2022 ... for `create_v2` coins, SPL Token for older coins." [P5]
  - The IDL also has a `toggle_create_v2` admin instruction [P14].
- **Extension list of `create_v2` coins:**
  - The only extension documented is **MetadataPointer → the mint itself** [P4].
  - A TokenMetadata extension on the mint is implied, because there is no Metaplex account in `create_v2`: **UNVERIFIED**.
  - The absence of TransferFee, TransferHook, PermanentDelegate, DefaultAccountState, Pausable and Confidential*: **UNVERIFIED**, since I could not check on-chain.
  - Mint and freeze authority after creation: **UNVERIFIED**. The mint authority account passed in is Pump PDA `["mint-authority"]` [P4].
- **Quote-mint side (for routing):** a Token-2022 quote mint "may only carry the xStock operable extension set": metadata pointer/metadata, permanent delegate, initialized default account state, scaled UI amount, pausable, confidential-transfer mint, and a transfer hook with no program [P14, `create_v2` docs].
- **Assessment:** read the project mint at config time and on every execution:
  - owner program
  - extension TLV list, allowing only `MetadataPointer` and `TokenMetadata`
  - `mint_authority`, `freeze_authority`, `decimals`

### 7.3 Quote assets
- **SOL-paired coins.** Pass wSOL `So11111111111111111111111111111111111111112` as `quote_mint`. "Trading will continue to happen with native SOL for all SOL-paired coins" [P1].
- **USDC-paired coins** exist (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) [P4]. Pump coins can also be the quote, up to depth 2 [P1].
- `BondingCurve.quote_mint` is `Pubkey::default()` for SOL-paired coins [P2].

### 7.4 Bonding-curve trade instructions
`buy_v3`, `buy_exact_quote_in_v3` and `sell_v3` take "17 accounts instead of 27 or 26", at the same prices and fees [P5]. The 17 accounts, in order [P5][P14]:

1. `global` (PDA `["global"]`)
2. `base_mint`
3. `quote_mint`
4. `base_token_program`
5. `quote_token_program`
6. `bonding_curve` (mut)
7. `associated_base_bonding_curve` (mut)
8. `associated_quote_bonding_curve` (mut; for SOL-paired coins pass the derived address, which "does not need to exist")
9. `user` (mut, **signer**)
10. `associated_base_user` (mut, **"Must exist."**)
11. `associated_quote_user` (mut; must exist for token-paired coins)
12. `user_volume_accumulator` (mut; "Created if missing, paid by `user`", 0.0018444 SOL)
13. `fee_config`
14. `buyback_fee_recipient` (mut; one of 8 wallets for SOL-paired coins, or that wallet's quote ATA; "**Must exist.**")
15. `system_program`
16. `event_authority`
17. `program`

**Instruction data** (IDL discriminators) [P5][P14]
| Instruction | Args | Discriminator |
|---|---|---|
| `buy_v3` | `amount u64, max_sol_cost u64, partial_fill OptionBool` | `[7,5,29,196,245,23,101,80]` |
| `buy_exact_quote_in_v3` | `spendable_quote_in, min_tokens_out, partial_fill` | `[225,247,80,30,213,179,132,136]` |
| `sell_v3` | `amount, min_sol_output` | `[28,146,222,119,38,196,105,213]` |

**Older interfaces that still work** [P1][P14]
- `buy` (16 accounts): `amount, max_sol_cost, track_volume, partial_fill`
- `sell` (14 accounts)
- `buy_exact_sol_in` (16 accounts)
- `buy_v2` / `buy_exact_quote_in_v2` (27 accounts) and `sell_v2` (26 accounts), with the full list in [P7]
- `buy_v2` / `sell_v2` need a normal or reserved `fee_recipient` plus a `buyback_fee_recipient` [P11]

**Constraints**
- **Cashback coins:** v3 trades fail with `CashbackCoinNotSupported` (6094) [P5].
- **Synthetic migration:** the buy that crosses the curve's end completes the curve. "After it, no buy or sell is possible on the curve until the migration happens." [P5]
- **Volume accumulator:** `init_user_volume_accumulator` has a separate `payer` signer and a non-signer `user`, so a keeper can pre-create the vault's accumulator [P14].

### 7.5 PumpSwap trade instructions
`buy_v2`, `buy_exact_quote_in_v2` and `sell_v2` take "17 accounts and no remaining accounts" and "work on every pool" except cashback pools (6079) [P6]. The 17 accounts, in order [P6][P14]:

1. `pool` (mut)
2. `user` (mut, **signer**)
3. `global_config`
4. `base_mint`
5. `quote_mint`
6. `user_base_token_account` (mut, must exist)
7. `user_quote_token_account` (mut, must exist; **a wSOL account for SOL pools**)
8. `pool_base_token_account`
9. `pool_quote_token_account`
10. `base_token_program`
11. `quote_token_program`
12. `system_program`
13. `user_volume_accumulator`
14. `fee_config`
15. `buyback_fee_recipient` (the quote ATA of one of the 8 buyback wallets; must exist)
16. `event_authority`
17. `program`

**Instruction data** [P6][P14]
| Instruction | Args | Discriminator |
|---|---|---|
| `buy_v2` | `base_amount_out, max_quote_amount_in` | `[184,23,238,97,103,197,211,61]` |
| `buy_exact_quote_in_v2` | `spendable_quote_in, min_base_amount_out` | `[194,171,28,70,104,77,91,47]` |
| `sell_v2` | `base_amount_in, min_quote_amount_out` | `[93,246,130,60,231,233,64,178]` |

**Other PumpSwap facts**
- v1 instructions: `buy` (23 accounts), `buy_exact_quote_in` (23), `sell` (21) [P14].
- **Quoting:** price against `effective_quote_reserves = pool_quote_token_account.amount + Pool::virtual_quote_reserves`. The latter is an `i128` that "can be negative" [P1][P3].
- **`multi_hop_swap(amount_in, min_amount_out)`** [P8]:
  - 16 fixed accounts plus 5 per hop; exact-in only.
  - "Four or more hops need a v0 transaction with an address lookup table."
  - About 30k–50k CU per hop.

**Buyback fee recipients** (any one; the same 8 for both programs) [P11]:
`5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD`, `9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7`, `GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL`, `3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR`, `5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6`, `EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL`, `5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD`, `A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW`.

### 7.6 Fees (as documented)
- **Dynamic fee tiers.** Fees are tiered by market cap in lamports. The change took effect "Monday, September 1, 20:00 UTC" (the year is not stated) and covers bonding curves and canonical PumpSwap pools; non-canonical pools use `feeConfig.flatFees` [P10].
- **Tier table** (`docs/fees.png`) [P10]:

| Venue / market cap | Creator | Protocol | LP | Total |
|---|---|---|---|---|
| Bonding curve | 0.30% | 0.95% | 0% | **1.25%** |
| PumpSwap, 0–420 SOL | 0.30% | 0.93% | 0.02% | 1.25% |
| PumpSwap, 420–1,470 SOL | 0.95% | 0.05% | 0.20% | 1.20% |
| … tapering by tier … | | | | |
| PumpSwap, ≥ 98,240 SOL | 0.05% | 0.05% | 0.20% | **0.30%** |

- **Fees can change.** Tiers are admin-updatable (`update_fee_config`, `upsert_fee_tiers` in Pump Fees [P14]).
- **Where fees go.** v3 and v2 trades keep protocol and creator fees on the curve or pool, to be swept later; "Same prices, same fees" [P1].
- **Older numbers.** The `Global.fee_basis_points` (100) and `GlobalConfig` lp 20 / protocol 5 bps examples are older snapshots [P2][P3].
- **Assessment:** compute expected output from on-chain `fee_config` plus reserves at execution time, and never hard-code tiers.

### 7.7 Can a program-controlled vault buy or sell via Pump?
**Assessment: yes, with caveats.**
- **CPI is documented.** "Your wrapper's `Accounts` struct must mirror pump's `BuyV2` account order exactly". Use `pump_rust_client::state` types, because older on-chain accounts are shorter than the IDL types [P9].
- **The PDA can sign as `user`.** `user` is `mut, signer` [P14]. A PDA can satisfy that through `invoke_signed` [S16].
- **SOL-paired curves move native lamports from and to `user`** [P1][P8], and `user` pays rent for `user_volume_accumulator` when it is missing [P5].
  - So `user` should be a **system-owned PDA with no data** (like the `SystemAccount` vault in [J9] and [S16]). This requirement is not stated by Pump: **UNVERIFIED**.
  - Alternatively, use USDC-paired coins or PumpSwap pools (wSOL token accounts).
- **Pre-create accounts.** Create the Token-2022 base ATA owned by the vault PDA, and pre-create the volume accumulator via `init_user_volume_accumulator` with a keeper as payer [P5][P14].
- **Compute.** Legacy buy/sell suggests a static limit of about `100_000` CU [P13]. The Rust example for `buy_v2` sets `400_000` [P7].
- **Operational risks:**
  - Breaking account-list upgrades have happened before, e.g. the "breaking program upgrade on April 28th" [P12].
  - The PumpSwap admin can `disable` buy and sell globally [P3].
  - Curves can be complete but not yet migrated [P5].
  - Pin program IDs, validate PDAs on-chain, and set `max_sol_cost` / `min_sol_output` from the vault's own math.

---

## 8. Jupiter Swap API

### 8.1 Current API
- **Base:** `https://api.jup.ag/swap/v2` [J1].
- **Meta-Aggregator** (`/order` + `/execute`). It "Returns an assembled transaction"; you sign and Jupiter lands it.
  - Routers: Metis, JupiterZ (RFQ), DFlow and OKX.
  - "Transactions routed through JupiterZ cannot be modified" [J1].
- **Router** (`GET /build`): raw instructions from **Metis only**, "for CPI, custom instructions and your own landing pipeline". "CPI use cases must use the Router" [J1].
- **Migration from v1.** `/swap/v1/quote` + `/swap/v1/swap-instructions` become `GET /swap/v2/build`. `userPublicKey` becomes `taker`. "`/build` is ExactIn only." No sunset date is given [J4].
- **Auth:** `x-api-key` [J3].
- **Rate limits** (60 s window, per organisation) [J6]:

| Tier | Requests/s | Key required |
|---|---|---|
| Keyless | 0.5 | No |
| Free | 1 | Yes |
| Developer | 10 | Yes |
| Launch | 50 | Yes |
| Pro | 150 | Yes |

`/execute` has a separate bucket [J6].

### 8.2 `GET /swap/v2/build` [J3]
- **Required params:** `inputMint`, `outputMint`, `amount`, `taker`.
- **Optional params:**
  - `slippageBps` (default 50, or `"rtse"`)
  - `payer` (defaults to `taker`)
  - `wrapAndUnwrapSol` (default true)
  - `dexes` | `excludeDexes` (labels are case-sensitive)
  - `maxAccounts` (1–64, default 64)
  - `destinationTokenAccount` | `nativeDestinationAccount`
  - `blockhashSlotsToExpiry` (1–300, default 150)
  - `transactionVersion` (`"0"` | `"1"`)
  - `computeUnitPricePercentile`, `mode=fast`, `forJitoBundle`, `tipAmount`, `platformFeeBps` + `feeAccount`
- **Response fields:**
  - amounts: `inAmount`, `outAmount`, `otherAmountThreshold`, `priceImpactPct`
  - `routePlan[]`: `swapInfo{ammKey,label,inputMint,outputMint,inAmount,outAmount}`, `percent`, `bps`
  - instructions: `computeBudgetInstructions` (price only, no limit), `setupInstructions`, `swapInstruction`, `cleanupInstruction` (nullable), `otherInstructions`, `tipInstruction`
  - `addressesByLookupTableAddress` (`{}` for v1)
  - `transactionVersion`, `computeUnitPrice`
  - `blockhashWithMetadata{blockhash,lastValidBlockHeight,fetchedAt}`
- **Instruction shape:** `{programId, accounts[{pubkey,isSigner,isWritable}], data(base64)}`.
- **Compute:** simulate at 1.4M CU, then set 1.2× the usage, capped at 1.4M [J2].
- **Fees and events:** the Router charges no Jupiter fee [J1]. "V2 instructions do not emit fee events" [J4].

### 8.3 Programs and accounts a route touches
- **Jupiter Aggregator program:** `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` [J8][J9].
  - V2 builds use "V2 routing instructions in the Jupiter Aggregator Program" [J4].
  - That the V2 instructions live at the same program ID: **UNVERIFIED**. Check `swapInstruction.programId` at runtime.
- **AMM programs** are listed only indirectly, via `routePlan[].swapInfo.ammKey/label`. Their accounts appear in `swapInstruction.accounts` [J3].
- **Pre-V2 instruction set** (2024 IDL) [J8]:
  - `route` (9 fixed accounts, incl. `userTransferAuthority` signer)
  - `sharedAccountsRoute` (13 accounts; uses Jupiter `programAuthority` PDAs `["authority", id]`, 8 of them, plus program-owned intermediate token accounts)
  - `routeWithTokenLedger` / `sharedAccountsRouteWithTokenLedger`, plus `setTokenLedger(tokenLedger, tokenAccount)`. Ledger semantics are **UNVERIFIED** (not described in the sources read).
  - `sharedAccountsExactOutRoute`
  - Whether V2 still exposes shared-accounts or token-ledger variants: **UNVERIFIED**. They are not mentioned in the V2 docs [J2][J3][J4].
- **Lookup tables.** v0 transactions use `addressesByLookupTableAddress`. v1 "inlines accounts" (4,096 bytes, no ALTs, 64 accounts) [J7].

### 8.4 Executing a route from a PDA vault
**Feasible via `/build`.**
- Jupiter: "use the swap instruction from `/build` as the inner instruction in a CPI call." [J5]
- The official example [J9] is an Anchor program with `vault` = `SystemAccount` PDA (seeds `["vault"]`). It passes route accounts as `remaining_accounts`, sets `is_signer` for the vault key, and calls `invoke_signed` into Jupiter.
- That example's client fetched `quote` + `swap-instructions` (v6 API) and compiled a **v0 message with the route's ALTs**, after a CU simulation.

**Constraints and risks**
1. **ALT claim conflict.** Jupiter docs state "CPI cannot use Address Lookup Tables (ALTs)" [J5], but their own example compiles the CPI wrapper with ALTs [J9]. **UNVERIFIED** which holds today; test both v0+ALT and v1 (no ALTs, 64 accounts) on mainnet simulation. [J10] also warns "CPI has size limit so it may not work with all routes".
2. **Account and CPI limits** [S7]:
   - Legacy and v0 transactions: 64 accounts. v1: up to 96 with SIMD-0596.
   - `MAX_CPI_ACCOUNT_INFOS` = 128 (255 with SIMD-0339).
   - `MAX_INSTRUCTION_STACK_DEPTH` = 5 (9 with SIMD-0268). Vault → Jupiter → AMM → token program already uses 4 levels. AMMs that CPI further, or Token-2022 hooks, can exceed the limit.
   - Use `maxAccounts` to shrink routes [J5].
3. **Signer privilege flows to unknown programs.** The vault PDA's signer privilege is forwarded by Jupiter into AMM programs. **Assessment:**
   - Use a dedicated per-rule escrow authority PDA that controls only that rule's source token account.
   - Check `program_id == JUP6…` (or an allowlist).
   - Ensure no other vault accounts appear as writable.
   - Enforce `min_out` by **diffing the destination balance before and after the CPI**, with `min_out` taken from the user's rule, not from the keeper or quote.
4. **Top-level-only helpers.** Setup and cleanup instructions (ATA create, wSOL wrap/unwrap) assume a signing `taker`. **Assessment:**
   - Set `wrapAndUnwrapSol=false` and pre-create the vault ATAs.
   - Run idempotent ATA creates at top level, with the keeper as `payer`.
   - Skip `cleanupInstruction` when it needs the owner's signature.
5. **Freshness.** The blockhash expires after the default 150 slots [J3]. Quotes go stale, so the keeper rebuilds on each attempt.
6. **Compute:** at most 1.4M CU per transaction [S7][J12], and CPI adds overhead [J5].
7. **Token-2022 outputs.** Transfer fees reduce the amount received, and hooks add accounts (section 9.5). Measure balances; don't trust `outAmount`.
8. **Meta-Aggregator is not CPI-composable.** `/order` returns an assembled transaction, and JupiterZ RFQ transactions "cannot be modified", so they cannot come from a PDA [J1].

---

## 9. Solana fundamentals

### 9.1 Commitment [S1][S2]
- **`processed`:** "The node's most recent processed block. This is the newest view, but it can still be rolled back."
- **`confirmed`:** "A block directly voted on by a supermajority of stake, meaning more than two-thirds of the network's active stake."
- **`finalized`:** "A block the cluster recognizes as finalized with maximum lockout." The default is "typically `finalized`" [S1].
- **Cookbook guidance** [S2]:
  - "roughly 5% of blocks don't end up being finalized by the cluster" (relevant to `processed`)
  - fetch blockhashes at `confirmed`
  - `finalized` is typically at least 32 slots behind `confirmed`, about 13 seconds
- **Assessment:** show "Confirmed" in the UI, but act irreversibly, for example by marking a rule settled in the indexer, only at `finalized`.

### 9.2 Blockhash expiry [S2][S7]
- Blockhashes stay valid for 151 blocks (`MAX_PROCESSING_AGE` = 150, counted from 0), about "60 to 90 seconds".
- Expired once block height > `lastValidBlockHeight`. Poll `getBlockHeight` at `confirmed` and keep resending until then.

### 9.3 Durable nonces [S3]
- A durable nonce "replaces the recent blockhash with a stored nonce value". It needs "AdvanceNonceAccount as the first instruction" and a writable nonce account.
- If execution fails, the nonce still advances and fees are charged.
- Warning: durable nonces "may be deprecated in a future release".
- **Assessment:** don't base the refund path on pre-signed nonce transactions. Make refunds permissionless after the deadline instead.

### 9.4 Ed25519 precompile + instruction introspection
- **Program ID:** `Ed25519SigVerify111111111111111111111111111`. "Precompiles are not callable via CPI." [S4]
- **Data layout** [S4]:
  - `u8` signature count, then 1 byte of padding
  - then one `Ed25519SignatureOffsets` per signature: `signature_offset`, `signature_instruction_index`, `public_key_offset`, `public_key_instruction_index`, `message_data_offset`, `message_data_size`, `message_instruction_index` (all `u16`)
  - An index of `u16::MAX` means "this instruction" (from the pseudocode)
- **Instructions sysvar:** `Sysvar1nstructions1111111111111111111111111`, read with `load_current_index_checked`, `load_instruction_at_checked` and `get_instruction_relative`. "The Instructions sysvar only contains top-level instructions from the transaction message." [S5]
- **Pattern (Assessment):** the keeper sends `[Ed25519 verify ix, vault.execute ix]` at top level. In `execute`, the vault:
  1. loads the instruction at `current-1` with the checked loader
  2. requires `program_id == Ed25519SigVerify111…`, a signature count of 1, and all three `*_instruction_index == u16::MAX` (or equal to that instruction's own index), so offsets cannot point at attacker-controlled data elsewhere
  3. requires the parsed public key to equal the configured resolver key
  4. requires the message to equal the canonical attestation bytes: domain tag, vault program ID, rule ID, venue, market ID, outcome, `resolved_at`, expiry, nonce

### 9.5 Token-2022 extensions dangerous for a vault [S8–S15]

| Extension | What it does (docs) | MAYBE policy (Assessment) |
|---|---|---|
| TransferFeeConfig | "The transferred amount is reduced by the configured fee". The fee can be changed "starting two epochs later" [S9] | Reject, or settle strictly on balance deltas |
| TransferHook | A CPI to a hook program "for every token transfer". Hooks can make transfers fail [S10] | Reject (unless the hook program is allowlisted) |
| PermanentDelegate | "can authorize transfers and burns for any token account for that mint". Holders cannot revoke it, and the mint authority can rotate it [S11] | Reject |
| NonTransferable | "tokens from this mint can't be transferred" [S8] | Reject |
| DefaultAccountState | New accounts can start frozen until the freeze authority thaws them. The default is updatable [S12] | Reject, or require that no freeze authority exists |
| ConfidentialTransferMint / ConfidentialMintBurn | Encrypted balances [S8] | Reject (breaks amount accounting) |
| Pausable | When paused, "the Token Extension Program rejects" transfers, mints and burns, mint-wide [S13] | Reject (could freeze refunds) |
| CpiGuard (account) | Blocks owner-authorized transfer, burn, approve and similar via CPI [S14] | Never enable on vault accounts. User deposits must be top-level instructions or use a delegate |
| MemoTransfer (account) | "requires a memo instruction immediately before any incoming transfer" [S15] | Refunds to such accounts fail unless a memo precedes them. Whether a memo can be satisfied under CPI: **UNVERIFIED** |
| Also review | InterestBearing and ScaledUiAmount (UI amount ≠ raw amount), MintCloseAuthority [S8] | Use raw amounts. Reject close authority |

Also check the legacy SPL `freeze_authority`: if one is set, the issuer can freeze vault token accounts (**Assessment**).

---

## 10. Open items (UNVERIFIED, needs a test or RPC)
1. The exact on-chain extension list, `mint_authority` and `freeze_authority` of a `create_v2` Pump coin, and of MAYBE's project mint specifically.
2. Whether a Pump SOL-paired buy works with a data-less system-owned PDA as `user` (devnet test).
3. Whether a Jupiter V2 `/build` route can be CPI'd inside a v0 transaction that uses ALTs, versus a v1 transaction. Also: the V2 program ID, and whether shared-accounts and token-ledger variants still exist.
4. DFlow: the production Metadata API hostname, the outcome-mint token program, the scalar-percentage field name, and the `marketLedger` program ID and layout.
5. Polymarket: `/price` side semantics, the meaning of `restricted`, and how voided markets surface.
6. Kalshi: the trades endpoint path and limits for unauthenticated reads.
