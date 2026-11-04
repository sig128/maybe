# Strategy semantics

What a MAYBE future means, precisely. The TypeScript engine (`packages/core`) and the vault program (`programs/crates/maybe-logic`) implement these rules identically; shared conformance fixtures (`packages/core/conformance/`) prove it.

## The document

A future (`maybe.strategy/1`, `packages/core/src/schema.ts`) has:

- **events**: up to 8 outcome events, each pinned to an on-chain event account, a venue market id and a **rule hash** (the exact rules text, frozen). Changing the rules is a different event.
- **allocations**: up to 4 amounts of one asset each, reserved from the vault's *available* balance at activation.
- **nodes**: up to 24 predicate nodes forming an acyclic graph (depth ≤ 8, ≤ 8 children per node).
- **actions**: up to 12 steps. Each spends from one allocation when its guard node is true.
- **expiresAt**: after this, nothing new executes and everything unspent returns to available.
- **maxFeeBps** (≤ 100), **cancelPolicy** (`anytime` | `locked-until-expiry`), **voidPolicy** (`void-is-false`, the only one in v1), a **nonce** (makes every authorization unique).

It compiles to a canonical binary plan (`MYB1`, ≤ 2,600 bytes). The plan hash is `sha256(bytes)`. The user signs transactions that commit that hash; the program refuses to activate bytes with a different hash and refuses to execute against a different hash.

## Outcomes and finality

An event has a status: `OPEN`, `PENDING` (an outcome was proposed and is in its challenge window), `DISPUTED`, or `FINAL`, and an outcome `YES`, `NO` or `VOID`.

- **Attestation events.** A threshold of distinct keys of the bound attestor set signs `MAYBE_ATTEST_V1 ‖ program ‖ event ‖ rule hash ‖ outcome ‖ observed_at ‖ nonce ‖ expires_at`. The outcome becomes final at `proposed_at + challenge window` without any further transaction (*lazy finality*). A conflicting attestation inside the window makes it `DISPUTED`; a dispute is never final until a super-threshold adjudicates it, or it times out to `VOID`.
- **Balance events** (objective). YES if the program observes the watched token account at or above the threshold at or before the deadline. Still open after the deadline means final `NO` at `deadline + 1`.
- **VOID.** With `void-is-false`, a voided event makes every outcome leaf on it false, so `YES` and `NO` conditions on it are both false. Plans that should refund on VOID simply never satisfy their spend guards and refund at completion or expiry.

## Predicates: time of truth

Each node evaluates to a pair `(t, f)`: the earliest time the node is known TRUE and the earliest time it is known FALSE (∞ = not yet known). Inputs are final, recorded facts, so `(t, f)` only moves from ∞ to a finite value, never changes afterwards, and never depends on when a keeper looks.

| Node | Rule |
|---|---|
| `outcome(e, o)` | `t = finalAt` if e is final with o; `f = finalAt` if final with anything else (including VOID) |
| `not(x)` | `t = x.f`, `f = x.t`. NOT of an unresolved event is unresolved, never true |
| `and(xs)` | `t = max xᵢ.t`, `f = min xᵢ.f` |
| `or(xs)` | `t = min xᵢ.t`, `f = max xᵢ.f` |
| `atLeast(k, xs)` | `t` = k-th smallest `xᵢ.t`; `f` = (n−k+1)-th smallest `xᵢ.f` |
| `veto(e, o, trigger, W)` | evaluation time `T = trigger.t + W`. If e is final with o at `v ≤ T`, `f = v` (vetoed). Final with o after T: `t = T` (veto too late). Final with another outcome at `u`: `t = min(T, u)`. Not final: `t = T` once `now ≥ T` |
| `receipt(strategy, action)` | `t` = first successful execution of that action; `f` = when it became impossible |
| `after(at)` | `t = at` once `now ≥ at` |
| `always` | `t` = activation time |

Value at `now`: TRUE if `t ≤ now`, FALSE if `f ≤ now`, otherwise PENDING. A contradiction (both finite) is treated as PENDING: fail closed.

## Readiness of a step

An action is **executable** at `now` only if all of these hold, in this order (the first failing check is the reported reason):

1. the strategy is ACTIVE (PAUSED blocks; any closed status is done);
2. it hasn't run all its runs;
3. `now` is before its deadline (default: the strategy's expiry);
4. if it belongs to a branch group, no *other* branch of the group has executed (**branch exclusivity**: the first branch to execute claims the group);
5. its guard is TRUE (FALSE ⇒ done; PENDING ⇒ waiting);
6. its run time has come: `guard.t + delay + run × interval` (schedules: up to 52 runs, interval ≥ 60 s; missed runs are skipped or caught up one per transaction);
7. the global emergency pause is off (it blocks new steps only; withdrawals, cancels, refunds and expiry closes keep working);
8. the amount is non-zero and the allocation holds enough.

Amounts: `fixed`, `bpsOfAllocation`, `bpsOfReceived` (a share of what an earlier step received, optional cap) and `allOfHolding` (optional cap). The fee is `floor(amount × feeBps / 10,000)`, taken from the amount, paid only to the asset's configured treasury, pro-rated to what a swap actually filled, and never charged on releases.

## Execution

One run of one action per transaction. The caller passes `(action, run, plan hash)`; the program recomputes readiness itself and requires `run` to equal its own counter, then advances it in the same transaction. A swap must:

- go to the configured program for its route kind, through the plan's own pool or market account;
- move no vault-owned token account other than the plan's source and destination;
- spend `0 < spent ≤ amount − fee` and deliver at least the minimum received (absolute, or a limit rate recomputed on what was actually spent).

A transfer pays only the plan's fixed recipient. If anything fails, the transaction reverts and nothing is consumed.

## Money

Per mint, the vault ledger keeps **available** and **reserved**:

- activation moves each allocation from available to reserved (and refuses if available is short);
- steps spend from, and receive into, their allocation's holdings (still reserved);
- closing (complete, expire, cancel) returns every holding to available;
- withdraw only ever touches available.

Invariants, checked after every operation in tests and by the reconciler against actual token balances: `token account = available + reserved` and `reserved = Σ holdings of active strategies`.

Cancelling returns what is unspent. It does not reverse completed trades or recover fees. Pausing stops new steps and keeps funds reserved. Unwinding an acquired position is a separate, new future (for example "sell on NO"), never an implicit side effect.

## Lifecycle

Formal transition tables live in `packages/core/src/state-machines.ts` (strategy, action, transaction, event, job, policy). Strategy: `DRAFT/INVALID/READY → AWAITING_SIGNATURE → UPLOADING → ACTIVATING → ACTIVE ⇄ PAUSED → COMPLETED | EXPIRED | CANCELLED | SUPERSEDED`, with `ACTIVATION_FAILED` as the recovery state (nothing reserved; re-authorizing resumes the upload).

An authorized version never changes. Editing creates a new version with a new nonce; authorizing it can replace the old one atomically (cancel + activate in one transaction).

## Not in the language

- Probability or price thresholds as automatic spending triggers (deferred; see `docs/DECISIONS.md` D10).
- Multiplying event probabilities as if outcomes were independent: the simulator enumerates outcome combinations; it never prices them.
- Unbounded loops, recursion, arbitrary instructions or generated code: unsupported logic is rejected at validation.
