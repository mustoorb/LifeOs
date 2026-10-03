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
- **No upload until the account service exists.** The companion exports a day as normalized events in a file the user saves.
