# Local-validator end-to-end run

Run: 2026-11-04T04:35:23.848Z · **all scenarios passed**

Real `maybe_vault` and `maybe_testvenue` programs on `solana-test-validator`, the API server and worker as separate processes, PostgreSQL, and a wallet that signs exact transaction bytes. Reproduce with `pnpm e2e:chain`.

## setup

| | Step | Observed | ms |
|---|---|---|---|
| ✓ | validator running and seeded |  | 55593 |
| ✓ | fresh database |  | 92 |
| ✓ | API server healthy | http://127.0.0.1:8799 | 2177 |
| ✓ | sign in with a wallet signature; local test funds | wallet E9Xu33… | 1773 |

## 1 · flagship: deposit → reserve → resolve → execute → refund → withdraw

| | Step | Observed | ms |
|---|---|---|---|
| ✓ | deposit 900 USDC (wallet-signed transaction) |  | 837 |
| ✓ | review: compile, simulate, describe | plan d4c2acbdcf5c…, reserves 500 USDC, worst case 500 USDC | 111 |
| ✓ | a stale review hash is refused |  | 62 |
| ✓ | authorize: upload, verify hash on-chain, reserve | strategy 4DN5ku…, 500 reserved, 400 available | 3271 |
| ✓ | A resolves YES (2 of 3 dev attestors) → portfolio A executes; release branch can't | Portfolio A · Lumen 60%: 180 USDC → 96671147 units; Portfolio A · Fern 40%: 120 USDC → 322253168 units | 6649 |
| ✓ | B YES, C NO → B∧C can never hold → completes; 200 refunded, holdings released | available: 600 USDC, LUMEN 96671147, FERN 322253168 | 7901 |
| ✓ | withdraw everything available |  | 953 |
| ✓ | reconciliation: token balances = available + reserved; reserved = Σ holdings | token balances = available + reserved; reserved = Σ holdings of 0 active future(s) | 10162 |

## 2 · failure and refund paths

| | Step | Observed | ms |
|---|---|---|---|
| ✓ | an event resolves VOID → every condition on it is false → full refund | 80 USDC reserved, VOID, 80 USDC returned, nothing bought | 9869 |
| ✓ | a signature that loses a race with a withdrawal fails on-chain and reserves nothing | Not enough available in your vault. Reserved funds can't be used twice. | 5167 |
| ✓ | after topping up, authorizing again resumes the upload and activates | Activate and reserve | 1599 |
| ✓ | cancel: everything unspent returns to available |  | 765 |
| ✓ | transactions prepared for a plan can't be signed after the future is edited | 409: The future was edited after these transactions were prepared. | 129 |
| ✓ | an activation recorded as failed but live on-chain is recognised, never funded twice | 409, row re-linked to AbFacM…; one account on-chain; reservation unchanged | 3204 |

## 3 · worker crash and restart: no duplicate spend

| | Step | Observed | ms |
|---|---|---|---|
| ✓ | authorize while no worker runs (event already final YES) |  | 2272 |
| ✓ | worker crashes after sending the execution | on-chain runs: 1; job still RUNNING; no receipt recorded | 1738 |
| ✓ | a fresh worker reclaims the job after the lease and finishes exactly once | 1 receipt, 1 on-chain execution, job attempts 2 | 4350 |
| ✓ | authorize while no worker runs (event already final YES) |  | 2246 |
| ✓ | worker crashes before sending the execution | on-chain runs: 0; job still RUNNING; no receipt recorded | 1782 |
| ✓ | a fresh worker reclaims the job after the lease and finishes exactly once | 1 receipt, 1 on-chain execution, job attempts 2 | 6492 |
| ✓ | API crashes after a deposit lands, before recording it | landed on-chain; recorded state was SUBMITTED, reset to SIGNED | 806 |
| ✓ | after its lease lapses, the intent resumes from the chain: confirmed once, never re-sent as new | DONE; transaction CONFIRMED; one activity entry; effect applied once | 6388 |
| ✓ | reconciliation still exact after the crashes | token balances = available + reserved; reserved = Σ holdings of 0 active future(s) | 27 |

## 4 · agents: injection does nothing; limits hold on-chain

| | Step | Observed | ms |
|---|---|---|---|
| ✓ | deposit 400 USDC so that only the policy, never the balance, can say no |  | 881 |
| ✓ | instructions injected into chat move nothing | 1 refusal(s); no transactions built; balances unchanged | 106 |
| ✓ | grant a policy: 100 USDC total, 60 per step, MAYBE pool only | policy 9cjRHK…, session key 4RRnZ7… | 1028 |
| ✓ | in policy: the agent's session key funds a 50 USDC future; the program charges the policy | policy spent 50 USDC of 100 | 2359 |
| ✓ | over the per-step cap: refused by the server's pre-check | Outside the policy: step 1 can spend 200000000 > per-step cap 60000000; step 2 can spend 200000000 > per-step cap 60000000; reserving 200000000 would exceed the total cap (50000000 of 100000000 used) | 44 |
| ✓ | bypassing the server: the program itself refuses a plan over the cap | PolicyViolation | 1034 |
| ✓ | bypassing the server: a route outside the policy is refused on-chain | PolicyViolation | 980 |
| ✓ | the session key can never withdraw | rejected: NotOwner | 10 |
| ✓ | kill switch: one owner signature voids every policy | a new in-limit plan from the session key is refused: PolicyRevoked | 770 |
| ✓ | activity trail records what happened, in plain language | 39 entries | 9 |
