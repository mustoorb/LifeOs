# Free hosting on Oracle Cloud

This guide runs LifeOS for $0 on an Oracle Cloud "Always Free" server. It uses a free web address
from DuckDNS and sends sign-in codes through Gmail. Everything runs on that one server, with HTTPS
and nightly backups: the LifeOS server, its database and the web home.

It takes about 45 minutes. Most of that is creating accounts; the setup script does the rest.

| You need | Cost |
|---|---|
| An Oracle Cloud account. A card is required to sign up, but Always Free resources are never charged. | $0 |
| A DuckDNS account, for a web address like `lifeos-sam.duckdns.org` | $0 |
| A Gmail account with 2-Step Verification. Use a separate one for LifeOS, such as `lifeos.codes@gmail.com`. | $0 |
| A Mac or PC with a terminal | — |

## 1. Create the Oracle account

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/).
2. **Pick your home region carefully.** It can't be changed later, and free servers only run in your home region. Choose one close to your members.

## 2. Create the server

In the Oracle console, open the menu, choose **Compute → Instances**, then **Create instance**.

1. **Name:** `lifeos`.
2. **Image and shape → Edit:**
   - **Image:** Change image → **Ubuntu** → **Canonical Ubuntu 24.04**.
   - **Shape:** Change shape → **Ampere** → **VM.Standard.A1.Flex** with **2 OCPUs** and **12 GB** of memory. It's marked *Always Free-eligible*.
3. **Networking:** keep the defaults, which create a network and a public subnet. Make sure **Automatically assign public IPv4 address** is on.
4. **Add SSH keys:** choose **Generate a key pair for me**, then **Save private key**. Keep that file safe: it's the only way into the server.
5. Click **Create**. When the server shows *Running*, copy its **Public IP address**.

If Oracle says **Out of capacity**, try one of these:

- Pick another *availability domain* in step 2.
- Ask for 1 OCPU and 6 GB instead.
- Try again later.
- Use the **VM.Standard.E2.1.Micro** shape (AMD, 1 GB). It's slower, but it works; the script adds swap space for it.

## 3. Open the web ports in Oracle's firewall

On the instance page, open the **subnet** link (under *Primary VNIC*), then **Security** → **Default Security List** →
**Add Ingress Rules**. Add two rules:

| Source CIDR | IP protocol | Destination port range |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

The server's own firewall is opened by the setup script.

## 4. Get a web address

1. Sign in at [duckdns.org](https://www.duckdns.org) with GitHub or Google.
2. Add a subdomain, for example `lifeos-sam`. Your address becomes `lifeos-sam.duckdns.org`.
3. Copy the **token** shown at the top of the page.

You don't need to type the IP into DuckDNS. The script sets it, and keeps it updated every 5 minutes.

## 5. Create a Gmail app password

1. In the Gmail account, turn on **2-Step Verification** at [myaccount.google.com/security](https://myaccount.google.com/security).
2. Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create one named `LifeOS` and copy the 16 letters.

Gmail allows about 500 emails a day, which is plenty for a founding cohort. To switch to a provider
like Resend or Postmark later, run the setup script again and choose *another SMTP provider*.

## 6. Run the setup script

On a Mac, open **Terminal** and connect to the server. Use the key file from step 2 and the server's IP:

```sh
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@YOUR-SERVER-IP
```

Answer `yes` the first time. Then, on the server:

```sh
curl -fsSL https://raw.githubusercontent.com/mustoorb/LifeOs/main/deploy/setup.sh -o setup.sh
sudo bash setup.sh
```

The script asks for your web address, DuckDNS token, Gmail address and app password, and tests each
one. It then does the following:

- installs Docker
- builds LifeOS
- starts it behind HTTPS
- sets up nightly backups
- offers to create the founding season and the access codes

At the end it prints the codes and your next steps.

## 7. Open the doors

1. Open `https://your-address.duckdns.org` and sign up with one of the codes.
2. Make yourself an admin: `sudo lifeos admin set-role you@example.com admin`.
3. Build the Mac app. In GitHub, go to **Actions → Companion release → Run workflow** and enter `https://your-address.duckdns.org`. See [deploy.md](deploy.md#3-build-the-mac-app).

## Day to day

Connect with `ssh` as in step 6, then:

| Command | What it does |
|---|---|
| `lifeos status` | Shows whether everything is running |
| `lifeos logs` | Follows the server log; `lifeos logs caddy` shows HTTPS |
| `lifeos admin issue-codes --campaign founding --count 10 --expires-days 30` | Creates more access codes |
| `lifeos admin list-codes` | Lists codes and how often each was used |
| `lifeos admin help` | Lists every admin command |
| `sudo lifeos update` | Installs the latest version from GitHub |
| `sudo lifeos backup` | Takes a backup now (one also runs every night) |

**Backups** are kept on the server in `/var/backups/lifeos` for 14 days. They protect against mistakes,
not against losing the server. To download the latest one to your Mac, every week or so:

```sh
ssh -i ~/Downloads/ssh-key-*.key ubuntu@YOUR-SERVER-IP \
  'sudo sh -c "cat \$(ls -t /var/backups/lifeos/*.sql.gz | head -1)"' > lifeos-backup.sql.gz
```

To restore a backup on the server (this replaces the current data):

```sh
cd /opt/lifeos && sudo zcat /var/backups/lifeos/FILE.sql.gz | sudo docker compose exec -T db psql -q -U lifeos lifeos
```

## Keeping the server from being reclaimed

Oracle may **stop** an Always Free server that looks idle for a week. That happens when its processor,
network *and* memory use all stay under 20%, which a small LifeOS cohort will. Stopping deletes nothing:
start it again from the console and LifeOS comes back by itself. To avoid the stops entirely:

- **Upgrade the account to Pay As You Go** (Billing → Upgrade). Always Free resources stay free, and
  upgraded accounts aren't reclaimed. Then set a **budget alert** at $1 (Billing → Budgets), so you
  hear about any charge at once.

## When something goes wrong

| Symptom | Fix |
|---|---|
| The script says HTTPS isn't reachable | Check the two rules from step 3, and that the address points to the server (`getent hosts your-address.duckdns.org`). Caddy keeps retrying; `lifeos logs caddy` shows its progress. |
| The script says the email login failed | Use an *app password*, not the account password, and check that 2-Step Verification is on. |
| Sign-in emails land in spam | Ask members to mark the first one as *not spam*. For a long-term fix, use your own domain with Resend or Postmark. |
| The site is down | Run `lifeos status`. If the server was stopped in the Oracle console, start it; LifeOS starts with it. |
