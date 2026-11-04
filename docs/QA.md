# Browser QA

Recorded 2026-11-04 against the web app in simulation mode (`apps/web/e2e`, Playwright 1.63 + Chromium, axe-core 4.14 via `@axe-core/playwright` 4.14). Machine: 2 vCPU Intel Xeon @ 2.1 GHz, 7 GB RAM, headless. Re-run with `pnpm --filter @maybe/web e2e`.

## Result

71 tests across three viewports — desktop 1440×900, laptop 1024×768, phone 390×844 (DPR 3, touch) — plus a 200 % zoom pass. Final run: **all pass** (the first full run found 2 failures and 11 accessibility violations, all fixed below).

| Area | What's checked | Result |
|---|---|---|
| Primary flow | draft → sentence / graph / list → review → both acknowledgements → simulated signature → active → resolve YES → time advances → steps execute; the losing branch never runs; no console errors | pass |
| Immutability | an authorized future opens read-only; "Edit as new version" creates a separate draft; the signed one is unchanged | pass |
| Accessibility (axe, WCAG 2.0/2.1/2.2 A+AA) | 9 main routes × 3 viewports, the market drawer, builder (sentence and list), review | 0 serious or critical violations |
| Keyboard | skip link first; visible focus on 15 consecutive tab stops; ⌘K / Ctrl+K palette; `g`+letter navigation; the review can be completed with the keyboard alone; Escape cancels the signature dialog and focus is trapped inside it | pass |
| Fund safety | dragging available money onto a draft opens a preview and changes nothing until confirmed (balances, allocations and activity compared before/after); 10 navigation shortcuts move nothing; a withdrawal over the available balance is refused and the button names why | pass |
| Layout | no horizontal page scroll on any route at 1440 / 1024 / 390, nor at 200 % zoom (720×450 CSS px), where primary navigation stays reachable | pass |
| Reduced motion | `prefers-reduced-motion: reduce` collapses the motion tokens to 0 ms | pass |

Screenshots of every route at each viewport are written to `apps/web/e2e/.output/shots/<viewport>/` by the suite.

### Accessibility findings fixed in this pass

1. **Label in name (WCAG 2.5.3)**, 6 elements: navigation links and the search button carried `aria-label`s that didn't contain their visible text (count badges, ⌘K hint), as did the wallet button and the Overview balance keys. Fixed by letting the visible text be the name and adding visually hidden context (", 1 active", "Wallet "). The collapsed rail keeps labels as visually hidden text instead of `display: none`.
2. **Sentence tokens**: event tokens read "Event A: …" while showing "A …"; the name now starts with the visible text.
3. **Scrollable regions (2.1.1)**: the content region and four sideways-scrolling tables weren't reachable by keyboard on screens without links; they're now focusable regions with names and a visible inset focus ring.
4. The Discover search field had only a placeholder; it now has a name and `type="search"`.

## Responsiveness

Long tasks (PerformanceObserver `longtask`) and input latency (Event Timing, entries ≥ 16 ms) while sample quotes tick every 5 s and the in-browser keeper runs every 1.5 s. Production build (`vite build` + `vite preview`), one test at a time:

| Scenario | Long tasks | Worst long task | Worst input event |
|---|---|---|---|
| Discover, 12 s of ticking quotes, then typing a search | 3 (280 ms total) | 118 ms | 56 ms |
| Builder: switch to graph (first node in 468 ms), list, sentence | 6 (468 ms total) | 132 ms | 40 ms |
| Money: switch tabs while the keeper ticks | 2 (165 ms total) | 95 ms | 16 ms |

The same scenarios on the unminified dev server ran 2–3× slower (worst input 288 ms on the first graph render, which loads React Flow lazily). These are numbers from one machine, not Core Web Vitals field data. The market list is virtualized (TanStack Virtual); the graph editor and charts are lazy chunks, so money screens never wait on them.

## Visual critique passes

**Pass 1** (after the primary flow worked): duplicate page titles removed; the outcome-paths diagram re-laid so its root is on screen and descriptions are readable; voided markets no longer sort first in Discover; slashed zeros removed from the numeric face; stale price ages flagged; duplicated issue text removed; graph layout de-cluttered; mobile tables replaced with lists; the cramped mobile builder bar split into two rows.

**Pass 2** (this pass, from the screenshots above):

- Graph view opened at ~55 % zoom with 7 px text, and two event nodes overlapped. Columns rebalanced (events get their own gap, the expiry node sits under the steps), events can no longer stack on each other, and the view now opens at a legible zoom (≥ 72 %), fitting the whole flagship plan at 1440 px.
- The "Can trigger futures" filter always showed a check mark, so it looked on when it was off. The check now appears only when the filter is active.
- On phones, market rows showed the spread and hid the price. They now show the YES price.
- On phones, the Overview total's explanation was squeezed into a narrow column beside the buttons. The buttons now wrap below.
- Futures cards were narrow enough to truncate their status line; the grid now uses wider columns.
- "Outside MAYBE" under the wallet balance was ambiguous; it now reads "Not in your vault yet".

## Not checked

- Screen-reader output with a real screen reader (VoiceOver / NVDA); naming was checked with axe and Playwright's accessibility tree only.
- Firefox and WebKit (only Chromium is installed here).
- The local-validator mode in a browser is exercised by a scripted run (`docs/evidence/localnet-ui/`), not by this suite.
