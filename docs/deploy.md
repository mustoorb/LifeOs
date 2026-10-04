# Taking LifeOS live

This guide gets LifeOS in front of a founding cohort. It covers the server, which also
serves the ECLIPSE home web app, and the macOS companion. Some steps need accounts that
only you can create; each of those is marked **you**.

## What you need

| | What | Notes |
|---|---|---|
| **you** | A host that runs a Dockerfile and PostgreSQL | Render, Railway, Fly.io and DigitalOcean App Platform all work, as does any Linux server with Docker (see option B below). |
| **you** | A domain, e.g. `lifeos.example.com` | The host or a reverse proxy provides HTTPS. Sign-in cookies require HTTPS in production. |
| **you** | An email provider with SMTP | Resend, Postmark, Amazon SES and others. Verify your sending domain with them so sign-in codes don't land in spam. |
| optional | Apple Developer Program membership | Lets you sign and notarize the Mac app. Without it, testers right-click → Open the first time. |

## 1. Deploy the server

**For a $0 setup**, follow **[deploy-oracle.md](deploy-oracle.md)** instead of this section. It covers an
Oracle Cloud Always Free server, a free DuckDNS address and Gmail, and `deploy/setup.sh` does the
installing. Then continue at step 2 below.

### Option A: a hosting platform

1. Create a **PostgreSQL 16** database. Copy its connection string.
2. Create a **web service** from this repository using the root `Dockerfile`. Use port `8787` and health-check path `/v1/health`.
3. Set these environment variables:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the connection string from step 1 |
   | `LIFEOS_SECRET` | 32+ random characters (`openssl rand -hex 32`) |
   | `SMTP_URL` | from your email provider, e.g. `smtps://resend:API_KEY@smtp.resend.com:465` |
   | `MAIL_FROM` | `LifeOS <hello@your-domain.com>` (an address your provider allows) |
   | `LIFEOS_TRUST_PROXY` | `1` (the platform's proxy supplies the client IP for rate limits) |

   `NODE_ENV=production`, `HOST` and `PORT` are already set in the image.
4. Attach your domain and turn on HTTPS.
5. Open `https://your-domain/v1/health`. It should say `{"ok":true}`.

On start the server applies database migrations and checks the SMTP connection. If either
fails it exits with the reason in the log.

### Option B: your own Linux server

```sh
git clone <this repo> lifeos && cd lifeos
cp .env.example .env      # fill in every value
docker compose up -d --build
```

Then put HTTPS in front of port 8787. With [Caddy](https://caddyserver.com), the whole
`Caddyfile` is:

```
lifeos.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

## 2. Open the doors

Run these in the server's shell. Platforms call it "Shell" or "Console"; with Docker
Compose, prefix each command with `docker compose exec server`.

```sh
# The founding season: six weeks from the date you choose.
node apps/server/dist/cli.js create-season --id founding-1 --name "Founding Season" \
  --starts 2026-11-02 --weeks 6 --campaigns founding

# One access code per founding member (each works once), valid for 30 days.
node apps/server/dist/cli.js issue-codes --campaign founding --count 30 --expires-days 30
```

Then sign up yourself at `https://your-domain` with one of the codes, and make yourself an
admin:

```sh
node apps/server/dist/cli.js set-role you@your-domain.com admin
```

`list-codes`, `revoke-code` and `audit` are there when you need them. Run `cli.js help` for
the full list.

## 3. Build the Mac app

1. **Optional, you:** add the signing secrets listed at the top of `.github/workflows/companion-release.yml` in the repository's GitHub settings under Secrets → Actions.
2. In GitHub, go to **Actions → Companion release → Run workflow**, and enter `https://your-domain`.
3. When it finishes, download the `lifeos-companion` artifact. It contains `.dmg` files for Apple silicon (arm64) and Intel (x64) Macs.

The app talks only to the server you entered. Members sign in from its window, turn on
upload, and use **Open your LifeOS home** to reach the web app.

## 4. Before inviting people

- **you:** Publish your **terms and privacy policy**. Registration records acceptance of the terms version `terms-2026-10`, but the text itself is yours to write and host. Have it reviewed (blueprint §20, §23).
- **you:** Confirm the names ECLIPSE and PROMETHEE are clear to use where you launch (blueprint §22).
- Send a test sign-in to an address at Gmail and one at Outlook, and check that the codes arrive.
- Back up the database. Most platforms offer daily backups; turn them on.
