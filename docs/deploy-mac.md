# Hosting on your Mac

This runs LifeOS on your own Mac for $0, with no card needed anywhere:

- **Docker** (OrbStack) runs the LifeOS server and its database.
- **Tailscale Funnel** gives it a permanent public HTTPS address, like `https://your-mac.tail1234.ts.net`.
- **Gmail** sends the sign-in codes.

Members need nothing but that address.

**LifeOS is only online while your Mac is on, awake and connected.** The members' Mac apps keep their
data and upload it when your Mac is back. The web home, though, is unreachable while your Mac sleeps.
That works for a small founding group. When you can, move to a server (see the end of this guide).

It takes about 20 minutes.

## 1. Docker (OrbStack)

1. Install [OrbStack](https://orbstack.dev) if you haven't, and open it.
2. In OrbStack's settings, turn on **Start at login**. LifeOS then comes back by itself after a restart.

## 2. Tailscale

1. Install Tailscale from [tailscale.com/download/mac](https://tailscale.com/download/mac) or the Mac App Store, and open it.
2. Sign in with Google, GitHub, Apple or Microsoft. The free Personal plan is enough, and it needs no card.
3. In Tailscale's menu-bar icon → **Settings**, turn on **Launch at login**.

Only LifeOS is published to the internet. Funnel exposes the one port that LifeOS listens on, and
nothing else on your Mac.

## 3. A Gmail app password

1. Use a separate Gmail account for LifeOS, such as `lifeos.codes@gmail.com`. Turn on **2-Step Verification** at [myaccount.google.com/security](https://myaccount.google.com/security).
2. Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create one named `LifeOS`, and copy the 16 letters.

## 4. Run the setup script

Open **Terminal** and paste:

```sh
curl -fsSL https://raw.githubusercontent.com/mustoorb/LifeOs/main/deploy/mac.sh -o mac.sh && bash mac.sh
```

The script does the following:

- checks that OrbStack and Tailscale are running
- downloads LifeOS into `~/LifeOS`
- asks for your Gmail address and app password, and tests them
- builds and starts LifeOS
- turns on Funnel
- sets up daily backups
- offers to keep your Mac awake while it's plugged in
- creates the founding season and the access codes

**If Tailscale prints a link** while turning on Funnel, open it, approve Funnel (and HTTPS) for this
Mac, then return to Terminal. Tailscale asks only the first time.

## 5. Open the doors

1. Open your `https://….ts.net` address and sign up with one of the codes.
2. Make yourself an admin: `lifeos admin set-role you@example.com admin`.
3. Build the Mac app. In GitHub, go to **Actions → Companion release → Run workflow** and enter your `https://….ts.net` address. See [deploy.md](deploy.md#3-build-the-mac-app).

## Day to day

Open a new Terminal window. The script added the `lifeos` command.

| Command | What it does |
|---|---|
| `lifeos status` | Shows whether LifeOS is running and reachable |
| `lifeos logs` | Follows the server log |
| `lifeos admin issue-codes --campaign founding --count 10 --expires-days 30` | Creates more access codes |
| `lifeos admin list-codes` | Lists codes and how often each was used |
| `lifeos update` | Installs the latest version from GitHub |
| `lifeos stop` / `lifeos start` | Takes LifeOS offline, or brings it back |
| `lifeos backup` | Takes a backup now |

**Keeping it online:**

- Leave the Mac plugged in, with the lid open. A closed lid makes most Macs sleep unless an external display is connected.
- The script can stop the Mac sleeping on power. The setting is also in System Settings → Battery (or Energy).
- After a restart, OrbStack and Tailscale start at login, and LifeOS starts with them.

**Backups** are saved once a day to `~/LifeOS-backups` while the Mac is awake, and kept for 14 days. Copy
one to iCloud Drive or an external disk now and then. To restore one (this replaces the current data):

```sh
cd ~/LifeOS && gunzip -c ~/LifeOS-backups/FILE.sql.gz | docker compose exec -T db psql -q -U lifeos lifeos
```

## Moving to a server later

When you have a card or a cheap server, follow [deploy-oracle.md](deploy-oracle.md) or [deploy.md](deploy.md).
Then:

1. Run `lifeos backup` here, and restore that file on the server.
2. The Mac app has its server address built in, so build it again with the new address. Members then install the new version.

## When something goes wrong

| Symptom | Fix |
|---|---|
| "Docker isn't running" | Open OrbStack and wait until it's running. |
| "Tailscale isn't connected" | Click the Tailscale menu-bar icon and connect. |
| The address doesn't load | Run `lifeos status`. If the server is healthy, run `tailscale funnel status`. If Funnel is off, run `tailscale funnel --bg 8787`. If `tailscale` isn't found, use `/Applications/Tailscale.app/Contents/MacOS/Tailscale` instead. |
| The email login fails | Use an *app password*, not the account password, and check that 2-Step Verification is on. |
| Sign-in emails land in spam | Ask members to mark the first one as *not spam*. |
