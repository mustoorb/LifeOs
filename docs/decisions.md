# Decisions log

The blueprint's §22 lists six decisions that must be made before implementation. The code
in this repository needs a working default for each one. The defaults below are
**proposals**. Each one is cheap to change, and the founder should confirm or override it.

| # | Decision | Working default | Where it lives in code | Status |
|---|---|---|---|---|
| 1 | Initial OS | macOS first. The domain core is OS-agnostic. Only the future companion shell is OS-specific. | `promethee/src/desktop.ts` takes OS-neutral `ForegroundSample`s | Proposed |
| 2 | Initial activity domain | Focus/creative desktop work plus **verified manual workout logging**. No fitness connector until one clears its §17 gate. | `MANUAL_LOG` connector; `weeklyMovementQuest` accepts `self_reported` | Proposed |
| 3 | Competitive posture | A small **friend leaderboard**, opt-in per season, with bounded seasonal score. No guild/country/global boards yet. | `FRIEND_LEADERBOARD`, `rankLeaderboard` | Proposed |
| 4 | Minimum age / launch countries | **18+** is enforced as a product floor. Launch countries are undecided and expressed per access code via `regions`. | `MINIMUM_AGE`, `AccessCode.regions` | Age: decided by blueprint §3. Countries: **open** |
| 5 | Monetary rewards | **None.** XP has no cash value, and nothing in the model can be converted or transferred. | `xp.ts` header | Follows blueprint recommendation |
| 6 | Name clearance (ECLIPSE / PROMETHEE) | Package names use the neutral `@lifeos/*` scope, so a rename only touches copy. | `packages/*/package.json` | **Open**: needs legal search |

## Implementation choices made along the way

- **Keystrokes are never modeled.** The blueprint's `keystroke_bucket?` metric is left out on purpose because §16.2 says not to capture keystrokes. `ActivityMetrics` has no field for keystrokes, window titles, URLs or routes.
- **Quest bonuses are separate awards.** They are not a multiplier on activity XP. This keeps each award explainable on its own and makes the "+5 quest bonus" line in §11 literal.
- **Self-reported XP is `provisional`.** It counts toward personal levels and is excluded from competitive scores (§10 tier 0).
- **Corroboration is earned, not declared.** A connector cannot claim tier 3 or tier 4 evidence. Tier 3 comes only from deduplication finding at least two independent non-manual sources.
- **Merging never widens visibility.** A merged activity takes the most restrictive visibility of its sources.
- **Unmapped apps never produce sessions.** Only apps the user has put in a category count toward anything. The companion keeps raw samples for unmapped apps on the Mac for up to 30 days, so the user can see what was in front and choose a category or exclude the app. Excluded apps are not recorded at all.
- **The desktop companion is Electron plus a small Swift helper.** Electron lets the companion run `@lifeos/promethee` unchanged instead of porting it to Swift. The helper reads only `NSWorkspace.frontmostApplication`, so the companion needs no Accessibility or Screen Recording permission. The cost is a larger app and higher idle memory than a native Swift app. Revisit after the founding season if power or size becomes a complaint.
- **The companion uploads only settled sessions, and only after the user turns uploading on.** Server events are immutable, so a session is sent once it can no longer grow. Deletions on the Mac follow to the account. Later category changes do not rewrite sessions already uploaded.
- **The server uses PostgreSQL.** Accounts, codes and activity are relational, and social features will need joins and row locks. Code redemption relies on `SELECT … FOR UPDATE` to enforce caps under concurrency.
- **Sign-in is passwordless, with emailed six-digit codes.** This means no password storage or reset flow, and it works inside the desktop app without a browser redirect. It does need an email provider, which is **open**. The server refuses to start in production until one is configured.
- **Birth dates are never stored.** Registration checks age against the code's minimum (18 or higher) and records only when the age gate passed.
- **Uploading activity needs its own consent.** Tracking on the Mac and uploading to the account are separate choices, so each one can be revoked independently.
- **The ECLIPSE home is a web client served by the account server.** The companion stays PROMETHEE: tracking, consent and upload. The game and planning live in ECLIPSE, which any device can open. All game logic runs server-side over stored evidence, so future clients reuse it.
- **XP is recomputed, never edited.** Every refresh re-derives activities and reconciles awards. If a correction or deletion changes the evidence, the old award is reversed and a new one is issued, so the ledger always explains itself.
- **Quests are offered, not imposed.** Today's focus quest and the weekly movement and recovery quests appear automatically. Any open quest can be skipped, and skipping has no penalty.
- **The recap's notes describe; they don't judge.** It has no streaks and no scores. It notes long days, missing movement and recovery, and changes from the previous week, and it asks whether it was accurate. That answer is half of the north-star metric.
