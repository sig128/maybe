# The web app on a local validator

Screenshots from one scripted browser session (Chromium, 1440×900) against the real stack: `solana-test-validator` with `maybe_vault` and `maybe_testvenue`, the API server with its worker, PostgreSQL, and the local development wallet. Captured 2026-11-04.

| | Screen | What it shows |
|---|---|---|
| 02 | Overview, connected | test funds airdropped to a fresh development wallet; nothing in the vault yet |
| 04 | Money | 900 USDC deposited by a wallet-signed transaction; the table splits wallet / available / reserved |
| 05 | Builder, sentence | the flagship plan made from a template, with this environment's real event, pool and mint addresses |
| 06 | Builder, graph | the same document as a graph |
| 07 | Review | every outcome path, worst case, fees and the acknowledgements, before signing |
| 09 | Signing | the four transactions in order: open vault token accounts, create the account (commits the hash), upload the plan, activate and reserve |
| 10 | Future, active | 500 USDC reserved by the program |
| 11 | Market drawer | local-validator controls: outcomes signed by 2 of 3 development attestor keys |
| 13 | Future, executed | after Orbit resolved YES and its 5 s challenge window passed, the keeper executed both portfolio A swaps; the release branch can no longer run |
| 13b | Future, completed | B YES and C NO make the B∧C step impossible; the program closed the future and returned 200 USDC plus the bought tokens to available |
| 14 | Activity | every step with who did it and the confirmed transaction |
| 15 | Operations | validator, keeper, reconciliation and attestor health; background jobs in plain words |
