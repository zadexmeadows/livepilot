# Points Bank architecture audit — 2026-09-20

## Existing architecture and evidence

- Next.js routes use Prisma 6 / SQLite. Google profiles are persistent Chromium directories referenced by GoogleAccount records. Account deletion can remove the profile and database record.
- `/api/streamlabs` owns both heist controls and bank commands. Bank configuration, balances, rounds (last 50) and transfers (last 100) are JSON AppSetting values. No ledger tables, database balance constraints or transfer idempotency keys exist.
- `load()` is called on dashboard refresh and overwrites runtime intelligence phase with IDLE. Async operation setup checks an unset promise before awaiting setup, allowing overlapping starts. JSON read/replace updates can lose changes.
- Browser accountAccess serializes individual sends, not full multi-account operations or external response matching. A fresh prepared page checks authentication immediately after DOMContentLoaded, explaining standalone banking failures while warm heist pages work.
- Confirmed transfers are applied opportunistically by the heist observer, clamping negative sender balances to zero. Standalone transfers instead rely on subsequent balance queries. No atomic paired ledger entries or durable pre-send intent exists.
- Heist participant membership comes from captain/join confirmations; only observed members are known. Payout includes returned wager: net = payout - wager. A 2674 payout on a 1337 wager means +1337; a loser means -1337. Existing code records summaries without posting balance impacts.
- Live commands use `!heist all`, so configured wager 1337 is NOT evidence of actual stake. Missing stake or interrupted capture must be marked for reconciliation, never silently assigned a fixed wager or missing players guessed.
- Balance verification overwrites the previous number. Derived transfers are incorrectly labelled verified. Historical loss/win data has no before/after snapshots.
- Points UI posts an entire stale Streamlabs configuration; bank Save can overwrite a more recently saved stream URL. UI analytics use truncated JSON histories. No Detailed Intelligent Analytics control exists in this checkout.
- Live audit: 5 selected profiles, bank cutiepie, reserve 5000; 405827 total last-known points, four confirmed accumulated transfers and one uncertain transfer. Historic snapshots are old and cannot be relabelled freshly verified.

## Implementation contract

Use additive SQLite tables and the existing Node runtime. A bank ledger service owns transactions and balances; a separate worker owns YouTube command workflows and bank settings; a Streamlabs adapter imports observed events; analytics aggregate persisted entries. Preserve original JSON as migration evidence.

Use SQLite BEGIN IMMEDIATE transactions and database unique event/request keys. No browser/network await is allowed inside an accounting transaction. Persist external transfer intent before sending; confirmation posts debit and credit atomically. Ambiguous delivery remains UNCERTAIN and is never resent. External commands cannot be rolled back by SQLite; reversals of local adjustments do not reverse external transfers.

Each points economy is explicitly scoped. Imported balances become opening entries; imported historical rounds/transfers remain archive evidence, not replayed changes. Unknown balances remain unknown. New rounds require known stakes and a complete capture before posting. Results debit stake and credit payout as a single net entry, preserving the existing payout convention. Intervening verification invalidates automatic historical posting and requires review.

Manual adjustments change the internal ledger, not Streamlabs' remote database, and must say so in the UI. External verification posts the difference as a correction, including zero-change verification records. Transactions are append-only; corrections use compensating entries. All API writes validate origin, amount, request key, reason and actor. Existing authenticated reverse-proxy access is the single administrator boundary.
