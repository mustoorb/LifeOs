# LifeOS: ECLIPSE + PROMETHEE

> Make your real life playable, without making it fake.

This repository holds a multiplayer Life RPG. Real, evidenced effort, on a computer and in
the physical world, becomes progress, reputation and community participation. The full
product thinking is in [`docs/blueprint.md`](docs/blueprint.md). Working defaults for its
open decisions are in [`docs/decisions.md`](docs/decisions.md).

## What's here

The repository holds the **domain core**, the **macOS desktop companion**, the **account
service** and the **ECLIPSE home** web client. The core is pure, dependency-free TypeScript that implements the
blueprint's evidence pipeline and game rules. The companion and the service both build on
it.

```
packages/
  contracts/   Shared types: ActivityEvent, DerivedActivity, evidence tiers, time helpers
  promethee/   Tracking & intelligence layer
  eclipse/     Life RPG layer
apps/
  companion/   macOS menu-bar companion (Electron + a Swift helper), see its README
  server/      Accounts, codes, seasons, upload and the ECLIPSE game engine (Hono + PostgreSQL)
  web/         ECLIPSE home: today, quests, review queue, XP explanations, weekly recap
test/          End-to-end daily-loop test spanning both layers
```

| Package | Module | Blueprint |
|---|---|---|
| promethee | `consent.ts`: append-only, granular, revocable consent ledger | §16.1 |
| | `connectors.ts`: declarative connector capabilities, sensitive-metric scopes | §17 |
| | `normalize.ts`: validation, duration bounds, metric filtering, idempotent ids, private by default | §9, §10 |
| | `desktop.ts`: local-first aggregation of foreground samples, pause, exclusions, focus blocks, "forget last hour" | §18 |
| | `dedupe.ts`: duplicate grouping, metric merge, earned corroboration, noisy-OR confidence | §9, §10 |
| | `anomaly.ts`: pace, step-rate, body/screen overlap and manual rate-limit flags | §10 anti-cheat |
| | `corrections.ts`: confirm / recategorize / discard / visibility, plus the correction queue | §5, §10 |
| eclipse | `skills.ts`: the 4-domain skill tree, eligible skills per activity, user allocation | §11 |
| | `xp.ts`: versioned ruleset, explained awards, diminishing returns, caps, reversal, reconciliation | §8, §11 |
| | `levels.ts`: account and skill level curves | §11 |
| | `quests.ts`: constrained rule builder, evaluation, pooled guild quests, templates | §12 |
| | `leaderboard.ts`: bounded seasonal score, bracketed opt-in ranking with shared ranks for ties | §13 |
| | `seasons.ts`: 6–12 week seasons, enrollment, archive and rollover | §14 |
| | `access-codes.ts`: readable codes, expiry/cap/age/region/revocation checks | §14 |

### Boundaries

ECLIPSE consumes only `@lifeos/contracts`, never PROMETHEE internals. A test
(`packages/eclipse/test/boundary.test.ts`) enforces this. That keeps the two products
separately bounded, as §2 and §8 require, even while they ship in one installer.

### Principles the code enforces

- **The evidence trail is immutable.** Source events are never mutated. Derived activities reference them, and every XP award records its rule version and basis.
- **Absence is not zero.** Metrics are optional, and a missing value is never coerced to 0.
- **Privacy by default.** Events default to `private`. Calendar context needs calendar consent. Heart rate and calories need health consent. Desktop samples carry no titles or content.
- **Explainable XP.** Each award carries human-readable lines, for example `25 Focus XP`, then `50 min digital session; observed evidence 1.0×`.
- **Fair competition.** Leaderboards use a bounded seasonal score from `awarded` quests and diverse activity, never lifetime XP. Opt-in is required, and provisional or flagged evidence is excluded.

## Development

Requires Node 22+.

```sh
npm install
npm run check      # typecheck + tests
npm test           # tests only
```

The server's integration tests need PostgreSQL. Set
`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres` to run them;
without it they are skipped.

For the apps, see [`apps/companion/README.md`](apps/companion/README.md) and
[`apps/server/README.md`](apps/server/README.md).

## Next steps (blueprint §21)

1. Choose an email provider and deploy the server and web client for the founding cohort.
2. Companion signing and notarization, an opt-in launch-at-login, and a link from the companion to the home.
3. Friends and invite-only groups, plus the friend leaderboard.
4. Instrumentation for the north-star metric, the **Weekly Meaningful Progress Rate**. The two inputs exist now: completed quests and recap feedback.
