# Local-validator end-to-end run

Run: 2026-11-04T03:15:48.231Z · **all scenarios passed**

Real `maybe_vault` and `maybe_testvenue` programs on `solana-test-validator`, the API server and worker as separate processes, PostgreSQL, and a wallet that signs exact transaction bytes. Reproduce with `pnpm e2e:chain`.

## setup

| | Step | Observed | ms |
|---|---|---|---|
| ✓ | validator running and seeded |  | 58526 |
| ✓ | fresh database |  | 176 |
| ✓ | API server healthy | http://127.0.0.1:8799 | 2169 |
| ✓ | sign in with a wallet signature; local test funds | wallet DXupYC… | 2865 |

## 1 · flagship: deposit → reserve → resolve → execute → refund → withdraw

| | Step | Observed | ms |
|---|---|---|---|
| ✓ | deposit 900 USDC (wallet-signed transaction) |  | 1014 |
| ✓ | review: compile, simulate, describe | plan 6a327189c4dc…, reserves 500 USDC, worst case 500 USDC | 138 |
| ✓ | a stale review hash is refused |  | 64 |
| ✓ | authorize: upload, verify hash on-chain, reserve | strategy AFpNW2…, 500 reserved, 400 available | 2695 |
| ✓ | A resolves YES (2 of 3 dev attestors) → portfolio A executes; release branch can't | Portfolio A · Lumen 60%: 180 USDC → 96671147 units; Portfolio A · Fern 40%: 120 USDC → 322253168 units | 6744 |
| ✓ | B YES, C NO → B∧C can never hold → completes; 200 refunded, holdings released | available: 600 USDC, LUMEN 96671147, FERN 322253168 | 8140 |
| ✓ | withdraw everything available |  | 2931 |
| ✓ | reconciliation: token balances = available + reserved; reserved = Σ holdings | token balances = available + reserved; reserved = Σ holdings of 0 active future(s) | 7291 |

## 2 · failure and refund paths

| | Step | Observed | ms |
|---|---|---|---|
| ✓ | an event resolves VOID → every condition on it is false → full refund | 80 USDC reserved, VOID, 80 USDC returned, nothing bought | 9059 |
| ✓ | a signature that loses a race with a withdrawal fails on-chain and reserves nothing | Not enough available in your vault. Reserved funds can't be used twice. | 2425 |
| ✓ | after topping up, authorizing again resumes the upload and activates | Activate and reserve | 1804 |
| ✓ | cancel: everything unspent returns to available |  | 840 |

## 3 · worker crash and restart: no duplicate spend

| | Step | Observed | ms |
|---|---|---|---|
| ✓ | authorize while no worker runs (event already final YES) |  | 1924 |
| ✓ | worker crashes after sending the execution | on-chain runs: 1; job still RUNNING; no receipt recorded | 3188 |
| ✓ | a fresh worker reclaims the job after the lease and finishes exactly once | 1 receipt, 1 on-chain execution, job attempts 2 | 3980 |
| ✓ | authorize while no worker runs (event already final YES) |  | 1735 |
| ✓ | worker crashes before sending the execution | on-chain runs: 0; job still RUNNING; no receipt recorded | 3669 |
| ✓ | a fresh worker reclaims the job after the lease and finishes exactly once | 1 receipt, 1 on-chain execution, job attempts 2 | 6248 |
| ✓ | reconciliation still exact after the crashes | token balances = available + reserved; reserved = Σ holdings of 0 active future(s) | 11128 |

## 4 · agents: injection does nothing; limits hold on-chain

| | Step | Observed | ms |
|---|---|---|---|
| ✓ | deposit 400 USDC so that only the policy, never the balance, can say no |  | 831 |
| ✓ | instructions injected into chat move nothing | 1 refusal(s); no transactions built; balances unchanged | 129 |
| ✓ | grant a policy: 100 USDC total, 60 per step, MAYBE pool only | policy kktVvq…, session key DbvxmU… | 1226 |
| ✓ | in policy: the agent's session key funds a 50 USDC future; the program charges the policy | policy spent 50 USDC of 100 | 1578 |
| ✓ | over the per-step cap: refused by the server's pre-check | Outside the policy: step 1 can spend 200000000 > per-step cap 60000000; step 2 can spend 200000000 > per-step cap 60000000; reserving 200000000 would exceed the total cap (50000000 of 100000000 used) | 46 |
| ✓ | bypassing the server: the program itself refuses a plan over the cap | PolicyViolation | 1012 |
| ✓ | bypassing the server: a route outside the policy is refused on-chain | PolicyViolation | 1092 |
| ✓ | the session key can never withdraw | rejected: NotOwner | 33 |
| ✓ | kill switch: one owner signature voids every policy | a new in-limit plan from the session key is refused: PolicyRevoked | 814 |
| ✓ | activity trail records what happened, in plain language | 37 entries | 9 |
