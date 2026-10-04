# LifeOS server

The ECLIPSE account, access-code and season service (blueprint §14, §21 step 2). It also
holds the first piece of the PROMETHEE ingestion pipeline: storing desktop activity uploaded
by the companion.

It is built on Node 22, [Hono](https://hono.dev), PostgreSQL 16 and zod. Access codes,
seasons and enrollment use the rules in `@lifeos/eclipse`. Activity is re-normalized with
`@lifeos/promethee`.

## Run it locally

```sh
createdb lifeos                               # any PostgreSQL 16 database
export DATABASE_URL=postgres://localhost/lifeos
export LIFEOS_SECRET=$(openssl rand -hex 32)  # keys the sign-in code HMAC

npm run build -w @lifeos/server
node apps/server/dist/cli.js create-season --id founding-1 --name "Founding Season" \
  --starts 2026-11-02 --weeks 6 --campaigns founding
node apps/server/dist/cli.js issue-codes --campaign founding --count 30 --expires-days 30
node apps/server/dist/server.js               # http://127.0.0.1:8787, migrates on start
```

Without `SMTP_URL`, sign-in codes are printed to the server log (development only). To
deploy, see [docs/deploy.md](../../docs/deploy.md). To make someone an
admin, have them sign up, then run `cli.js set-role <email> admin`.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `LIFEOS_SECRET` | At least 32 characters (required) |
| `PORT`, `HOST` | Default `8787`, `127.0.0.1` |
| `SMTP_URL`, `MAIL_FROM` | Any SMTP provider. Required in production; without them, codes are printed to the log (development only). |
| `LIFEOS_TRUST_PROXY=1` | Read the client IP from the last `X-Forwarded-For` entry, the one your proxy added. Set this only behind your own proxy. |

## API

Errors look like `{ "error": { "code": "...", "message": "..." } }`. Signed-in routes take
`Authorization: Bearer <token>`.

| Route | Purpose |
|---|---|
| `POST /v1/auth/start` `{email}` | Email a six-digit code. Always `202`, so the response doesn't reveal whether an account exists. |
| `POST /v1/auth/verify` `{email, code, deviceLabel}` | Returns `signed_in` with a token, or `registration_required` with a 30-minute ticket. |
| `POST /v1/accounts` `{registrationToken, accessCode, birthDate, region, displayName, acceptedTerms, deviceLabel}` | Age gate (18+, birth date not stored), redeem the code, enroll in the campaign's season, sign in. |
| `GET/PATCH/DELETE /v1/me` | Profile and privacy settings. Deletion is immediate and needs `{confirmEmail}`. |
| `GET /v1/me/export` | Everything stored about the account, as JSON. |
| `GET /v1/me/sessions`, `DELETE /v1/me/sessions/:id`, `POST /v1/auth/logout` | Devices. |
| `GET /v1/me/consents`, `PUT /v1/me/consents/:scope` `{granted}` | Append-only consent ledger. |
| `PUT /v1/me/enrollments/:seasonId` `{leaderboardOptIn}` | Opt in to ranking. Off by default. |
| `GET/POST /v1/me/invites` | Single-use friend invites into your cohort. Up to 3 can be unused at once. |
| `POST /v1/me/activity/desktop` | Upload a companion export. Needs `desktop_activity` consent. |
| `GET/DELETE /v1/me/activity?from&to` | List events starting in the range, or delete every event that overlaps it. |
| `/v1/admin/access-codes`, `/v1/admin/seasons`, `/v1/admin/accounts`, `/v1/admin/audit` | Admin only. |

## ECLIPSE home

The game runs on the server, so every client sees the same state. `GameEngine.refresh`
(`src/game.ts`) is idempotent and serialized per account. It runs after uploads, deletions,
manual logs and corrections, and on each home or recap request. Each run:

1. Re-derives the last 35 days of activity from stored events with `@lifeos/promethee` (deduplication, then the member's corrections, then anomaly checks).
2. Reconciles the XP ledger with `@lifeos/eclipse`. If an activity changed, its award is reversed and recomputed; if the activity is gone, its award is reversed. Awards are never edited except to be reversed, and each one keeps its explanation lines.
3. Creates today's focus quest and this week's movement and recovery quests in the member's time zone, then awards or withdraws quest bonuses.

| Route | Purpose |
|---|---|
| `GET /v1/home?tz=` | Level and skills, today's priorities, quests, activity with XP explanations, the review queue, recent XP, the season |
| `POST /v1/me/activities/:id/correction` `{kind: confirm \| discard \| recategorize, type?}` | Corrections. They are anchored to a source event, so they survive re-derivation. |
| `POST /v1/me/activity/manual` | Self-reported workouts and sessions. They earn provisional XP and never count toward rankings. |
| `POST/PATCH/DELETE /v1/me/priorities` | Up to 3 per local day |
| `POST /v1/me/quests/:id/skip` | Skip an open quest |
| `GET /v1/recap?week=&tz=`, `PUT /v1/recap/:week/feedback` `{accurate}` | The private weekly recap, and "did this represent your week?" |

The web client (`apps/web`) is served at `/` when it has been built. It signs in with an
HttpOnly, SameSite=Strict cookie that page scripts can't read. Cookie-authenticated writes
must also carry `X-LifeOS-Client: web`, which blocks cross-site request forgery. The page has
a strict CSP and no third-party resources.

## Security and privacy

- **Passwordless sign-in.** Codes are stored as HMAC-SHA256, expire after 10 minutes and allow 5 attempts. One email can receive at most 5 codes an hour, and each IP is limited too.
- **Sessions are opaque tokens.** The database holds only their SHA-256. Each session slides out to 30 days from last use, and every device can be listed and revoked.
- **Registration happens in one transaction.** A rejected access code leaves the email ticket usable. Code rows are locked during redemption, so a single-use code cannot be redeemed twice even by concurrent requests (tested).
- **Deleting an account removes everything that belongs to it.** Code redemptions remain, anonymized, so deletion can't reopen a capped code.
- **Uploads are re-validated server-side.** Ids, evidence tier, confidence and visibility are recomputed, never taken from the client. Activity needs its own consent on the account, separate from tracking consent on the Mac.
- **The audit log records actors and targets as opaque ids.** It holds no emails.
- **HTTP hardening:** security headers, a 2 MB body limit, JSON-only errors, and a 500 that never leaks internals.

## Not done yet

- **Shared rate limiting.** The limiter is in memory, which is correct for one instance only.
- **An admin web console.** Admin work currently goes through the CLI or the admin API.
- **Background refresh.** Game state refreshes on requests and uploads, not on a schedule. A quest that ends while nobody looks is settled on the next visit, which is correct but late.

## Tests

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test
```

Each test file creates and drops its own database. Without `TEST_DATABASE_URL` the
integration tests are skipped. CI runs them against a Postgres 16 service and fails if they
were skipped.
