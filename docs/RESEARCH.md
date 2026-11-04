# MAYBE: design research note

Date: 2026-11-04. Scope: interaction patterns for "IF a market resolves YES, THEN swap, OTHERWISE refund, BEFORE the deadline" rules. The integration facts are in [research/INTEGRATIONS.md](research/INTEGRATIONS.md).

Evidence tags:
- **[seen]**: in a screenshot I took on 2026-11-04 in the desktop app's built-in browser (logged out, no wallet, a pane of about 800×600).
- **[page text]**: text extracted from the page.
- **[docs]**: developer documentation.

## Sources (accessed 2026-11-04)

| Reference | URL | Evidence |
|---|---|---|
| Linear, "A calmer interface for a product in motion" (dated 2026-03-12) | https://linear.app/now/behind-the-latest-design-refresh | [seen] [page text] |
| Linear homepage | https://linear.app | [seen] [page text] |
| Phantom Prediction Markets (product images are marketing mockups) | https://phantom.com/prediction-markets | [seen] [page text] |
| Jupiter swap, Predict list, one event page | https://jup.ag, https://jup.ag/prediction, https://jup.ag/prediction/POLY-32225 | [seen] [page text] |
| Jupiter developer docs (dev.jup.ag redirects here) | https://developers.jup.ag/docs | [docs] |

## Observed patterns

### Linear
- **Quiet navigation.** The sidebar is dimmed so it no longer competes with the work area. The principles are "Don't compete for attention you haven't earned" and "Structure should be felt, not seen" (fewer, softer, rounded dividers) [page text]. A before/after image is annotated with smaller icons, muted inactive items and extra vertical padding. The active item gets a subtle fill [seen].
- **Predictable action placement.** A diagram layers App, Location bar, View bar and Content, and each band holds its own actions [seen]. Header actions were made consistent [page text].
- **Density without noise.** Tabs are compact with icon-only pills, and the grays are warmer [page text].
- **Detail layout.** Content sits on the left with a properties panel (status, priority, assignee, labels) on the right, plus an Activity timeline mixing human and system events [seen].
- **Keyboard.** None of the visited pages mention keyboard commands, so I make no claim.

### Phantom Prediction Markets
- **Positions sit with other balances.** On wallet home, a "Predictions" row shows P&L and an inline "Claim Payout" above the tokens [seen].
- **Discovery.** Featured, trending and live markets plus category filters [page text]. Rows show outcome-percentage pills and volume [seen].
- **Compact ticket.** The flow is pick an outcome, enter an amount, confirm [page text]. A bottom sheet titled "Buy Yes · <outcome>" has a Yes/No toggle and a large amount-first "$0" [seen].
- **Event detail.** A probability split bar, line labels at the end of each line, range tabs, and two outcome buttons with their percentages [seen].
- **Contextual drawer.** Each market has a chat sheet where users carry position badges and trade events appear in the stream [seen].
- **Risk copy.** "may lose the entire amount"; "not available in all jurisdictions". Kalshi data comes through DFlow [page text].

### Jupiter
- **Navigation.** The sidebar is grouped (Trade/Labs/Earn/Manage) with Beta/New badges, and collapses to an icon rail inside Predict [seen].
- **Discoverability and keyboard.** The search box shows a "/" hint. It opens an overlay with grouped results (Tokens with a "Verified" toggle, then Stocks), price/MC/vol/liquidity columns, favorites, and "Paste" and "Esc" chips. Escape closes it [seen].
- **Swap ticket.** Market/Limit/DCA tabs sit above stacked Sell/Buy fields: amount on the left, token pill on the right, a flip button, and a "Paste CA" chip. One full-width CTA reads "Connect" while logged out. There is a "Use V1 transactions" toggle [seen]. Balance and Max were not visible without a wallet.
- **Number formatting.** Tiny prices use subscript zeros ("$0.0₄427") [seen].
- **Prediction ticket.** It is docked on the right and stays visible while scrolling. It shows:
  - a context line ("Buy Yes · Democratic Party")
  - the price in cents, ticking live from 99.3¢ to 99.4¢
  - "You're paying" with the balance inline ("0 USDC")
  - an Odds row
  - a CTA that names what is missing ("Enter Amount") [seen]
- **Charts.** Lines are labeled at their ends. The hover crosshair shows a timestamp and updates the legend and big numbers. Presets are 1D/1W/1M/ALL [seen].
- **Progressive disclosure.** The rules text is truncated with "Show more". A collapsible "Timeline and payout" stepper reads Market open → Market closes → Projected payout within 24 hours of finalization [seen].
- **Positions.** Columns include "Payout if right" and PNL excluding fees [page text].
- **Warning sign.** The comments held scam links, and the UI shows "Beware of external links" [seen].
- **Transaction feedback.** Not observed (no wallet). Built routes return `lastValidBlockHeight` [docs].

## What MAYBE adopts

1. **Amount-first ticket.** Balance and Max sit inline in the "You pay" row. The CTA names the next blocker ("Enter amount", "Insufficient USDC").
2. **Rule ticket in sentence form.** IF / THEN / OTHERWISE / BEFORE are stacked like Sell/Buy fields. Each clause pill opens an inline picker, and one primary action arms the rule.
3. **Command palette on ⌘K, with "/" as an alias.** Results are grouped as Markets, Tokens and My rules, with a Verified filter, a paste-address chip and Esc to close.
4. **Quiet chrome.** Dimmed sidebar, muted inactive items, few borders, and one accent for the primary action.
5. **Fixed header slots.** The location bar shows where you are; the view bar holds rule actions that never move.
6. **Rule detail.** Content, a properties panel (status, venue, deadline, locked amount, route) and an Activity log with transaction links.
7. **Resolution stepper on every rule.** Open → closes → dispute/settlement window → execute or refund by the deadline, with a truncated rules summary and a link to the source.
8. **Number display.** Odds as percentages with cents as secondary text; subscript zeros for tiny prices.
9. **Probability chart.** End labels, a crosshair that updates the headline, range presets, no candles by default.
10. **Rules as balances.** Home lists armed rules and their locked amounts, with an inline Refund or View swap.
11. **Contextual drawers.** The ticket is a bottom sheet on mobile and a right dock on desktop.
12. **Transaction feedback.** Submitted → Confirmed → Finalized, with an expiry countdown from `lastValidBlockHeight`. This is a MAYBE decision based on the Solana docs, not something I observed.
13. **Leave out at launch:** open comments and chat, and gamification.

## Evidence level

These are **observed patterns, not measured usability evidence**. No conversion or usability statistics are claimed.
- Screenshots come from one day, one small viewport, logged out. Wallet-connected states were not observed.
- Phantom's views are marketing mockups.
- [page text] is automated extraction and may paraphrase.
- I record patterns, not branding; brand assets should not be reproduced.
