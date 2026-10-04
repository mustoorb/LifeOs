#!/usr/bin/env bash
# Installs LifeOS on a fresh Ubuntu server, with HTTPS and nightly backups.
# Written for Oracle Cloud's Always Free tier (see docs/deploy-oracle.md); any Ubuntu server works.
#
#   curl -fsSL https://raw.githubusercontent.com/mustoorb/LifeOs/main/deploy/setup.sh -o setup.sh
#   sudo bash setup.sh
#
# Safe to run again: it keeps the database password and secret, and offers your previous answers.
set -euo pipefail

REPO_URL=${LIFEOS_REPO:-https://github.com/mustoorb/LifeOs.git}
BRANCH=${LIFEOS_BRANCH:-main}
DIR=/opt/lifeos
ENV_FILE=$DIR/.env
DUCKDNS_FILE=/etc/lifeos/duckdns

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\n\033[33mWarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ask VAR "Question" [default]
ask() {
  local var=$1 prompt=$2 default=${3:-} answer
  [[ -n $default ]] && prompt="$prompt [$default]"
  read -r -p "    $prompt: " answer </dev/tty
  printf -v "$var" '%s' "${answer:-$default}"
}

# ask_secret VAR "Question" [current value, kept when the answer is empty]
ask_secret() {
  local var=$1 prompt=$2 current=${3:-} answer
  [[ -n $current ]] && prompt="$prompt (press Enter to keep the current one)"
  read -r -s -p "    $prompt: " answer </dev/tty
  echo
  printf -v "$var" '%s' "${answer:-$current}"
}

yes_no() { # yes_no "Question" Y|N
  local reply # not "answer": ask() has a local of that name, which would shadow ours
  ask reply "$1 (y/n)" "$2"
  [[ $reply =~ ^[Yy] ]]
}

urlencode() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

# Logs in to the SMTP server in $1, the way the LifeOS server will. Prints the problem on failure.
test_smtp() {
  SMTP_TEST_URL=$1 python3 - <<'PY'
import os, smtplib, socket, ssl, sys, urllib.parse
url = urllib.parse.urlsplit(os.environ["SMTP_TEST_URL"])
user = urllib.parse.unquote(url.username or "")
password = urllib.parse.unquote(url.password or "")
context = ssl.create_default_context()
try:
    if url.scheme == "smtps":
        server = smtplib.SMTP_SSL(url.hostname, url.port or 465, timeout=20, context=context)
    else:
        server = smtplib.SMTP(url.hostname, url.port or 587, timeout=20)
        server.starttls(context=context)
    if user:
        server.login(user, password)
    server.quit()
except smtplib.SMTPAuthenticationError:
    print("The mail server rejected the address or password.")
    sys.exit(1)
except smtplib.SMTPException as error:  # a subclass of OSError, so it goes first
    print(f"The mail server said: {error}")
    sys.exit(1)
except OSError as error:
    print(f"Couldn't reach the mail server ({error}).")
    sys.exit(1)
PY
}

# Accept web traffic in the host firewall. Oracle's Ubuntu images reject everything except SSH.
open_port() {
  local proto=$1 port=$2 reject
  command -v iptables >/dev/null || return 0
  iptables -C INPUT -p "$proto" --dport "$port" -j ACCEPT 2>/dev/null && return 0
  reject=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
  if [[ -n $reject ]]; then
    iptables -I INPUT "$reject" -p "$proto" --dport "$port" -j ACCEPT
  else
    iptables -A INPUT -p "$proto" --dport "$port" -j ACCEPT
  fi
  FIREWALL_CHANGED=1
}

[[ $EUID -eq 0 ]] || fail "Run this with sudo: sudo bash setup.sh"
command -v apt-get >/dev/null || fail "This script needs Ubuntu or Debian."

PREVIOUS_INSTALL=0
[[ -f $ENV_FILE ]] && PREVIOUS_INSTALL=1

cat <<'EOF'

  LifeOS server setup
  -------------------
  This installs Docker, the LifeOS server, its database and HTTPS (Caddy),
  then sets up nightly database backups. It takes about 10 minutes.

EOF

# ---------------------------------------------------------------------------
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl python3 cron >/dev/null

if (( $(awk '/MemTotal/ { print $2 }' /proc/meminfo) < 2000000 )) && ! swapon --show | grep -q .; then
  note "Less than 2 GB of memory: adding a 2 GB swap file so the build fits."
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# ---------------------------------------------------------------------------
say "Opening ports 80 and 443 in the server's firewall"
FIREWALL_CHANGED=0
open_port tcp 80
open_port tcp 443
open_port udp 443
if (( FIREWALL_CHANGED )) && command -v netfilter-persistent >/dev/null && ! systemctl is-active --quiet docker; then
  netfilter-persistent save >/dev/null 2>&1 || warn "Couldn't save the firewall rules; they will reset on reboot."
fi
note "Oracle also has a cloud firewall (the security list). The guide shows how to open the same ports there."

# ---------------------------------------------------------------------------
say "Installing Docker"
if command -v docker >/dev/null; then
  note "Docker is already installed."
else
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1
[[ -n ${SUDO_USER:-} && $SUDO_USER != root ]] && usermod -aG docker "$SUDO_USER"

# ---------------------------------------------------------------------------
say "Getting the LifeOS code"
if [[ -d $DIR/.git ]]; then
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH"
  git -C "$DIR" pull -q --ff-only origin "$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
note "$(git -C "$DIR" log -1 --format='%h %s')"

# ---------------------------------------------------------------------------
say "Settings"
LIFEOS_DOMAIN='' POSTGRES_PASSWORD='' LIFEOS_SECRET='' SMTP_URL='' MAIL_FROM=''
if (( PREVIOUS_INSTALL )); then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  note "Found the settings from your last run; press Enter to keep each one."
fi

while true; do
  ask LIFEOS_DOMAIN "Web address for LifeOS, e.g. lifeos-sam.duckdns.org" "$LIFEOS_DOMAIN"
  LIFEOS_DOMAIN=${LIFEOS_DOMAIN,,}
  LIFEOS_DOMAIN=${LIFEOS_DOMAIN#https://}
  LIFEOS_DOMAIN=${LIFEOS_DOMAIN%%/*}
  [[ $LIFEOS_DOMAIN =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] && break
  note "That doesn't look like a web address. Use just the name, like lifeos-sam.duckdns.org."
done

if [[ $LIFEOS_DOMAIN == *.duckdns.org ]]; then
  DUCKDNS_NAME=${LIFEOS_DOMAIN%.duckdns.org}
  DUCKDNS_NAME=${DUCKDNS_NAME##*.}
  DUCKDNS_TOKEN=''
  # shellcheck source=/dev/null
  [[ -f $DUCKDNS_FILE ]] && source "$DUCKDNS_FILE"
  while true; do
    ask_secret DUCKDNS_TOKEN "Your DuckDNS token (shown at the top of duckdns.org after signing in)" "$DUCKDNS_TOKEN"
    result=$(curl -fsS --max-time 20 "https://www.duckdns.org/update?domains=${DUCKDNS_NAME}&token=${DUCKDNS_TOKEN}&ip=" || true)
    [[ $result == OK ]] && break
    note "DuckDNS didn't accept that. Check the token, and that '$DUCKDNS_NAME' is one of your domains on duckdns.org."
  done
  mkdir -p "$(dirname "$DUCKDNS_FILE")"
  (umask 077 && printf 'DUCKDNS_NAME=%q\nDUCKDNS_TOKEN=%q\n' "$DUCKDNS_NAME" "$DUCKDNS_TOKEN" >"$DUCKDNS_FILE")
  note "DuckDNS now points $LIFEOS_DOMAIN at this server."
fi

KEEP_MAIL=0
if [[ -n $SMTP_URL ]]; then
  note "Email is set up to send from: $MAIL_FROM"
  yes_no "Keep these email settings?" Y && KEEP_MAIL=1
fi
while (( ! KEEP_MAIL )); do
  ask MAIL_KIND "Send sign-in emails with 1) Gmail or 2) another SMTP provider" 1
  if [[ $MAIL_KIND == 2 ]]; then
    ask SMTP_URL "SMTP URL, e.g. smtps://user:password@smtp.example.com:465"
    ask MAIL_FROM "Send from, e.g. LifeOS <hello@example.com>"
  else
    ask GMAIL_ADDRESS "Gmail address"
    ask_secret GMAIL_APP_PASSWORD "Gmail app password (16 letters)"
    GMAIL_APP_PASSWORD=${GMAIL_APP_PASSWORD// /}
    if [[ ! $GMAIL_APP_PASSWORD =~ ^[A-Za-z]{16}$ ]]; then
      note "An app password is 16 letters, from myaccount.google.com/apppasswords. Your normal password won't work."
      continue
    fi
    SMTP_URL="smtps://$(urlencode "$GMAIL_ADDRESS"):${GMAIL_APP_PASSWORD}@smtp.gmail.com:465"
    MAIL_FROM="LifeOS <$GMAIL_ADDRESS>"
  fi
  if [[ $SMTP_URL == *"'"* || $MAIL_FROM == *"'"* ]]; then
    note "Settings can't contain a single quote (')."
    continue
  fi
  note "Checking the email login..."
  if problem=$(test_smtp "$SMTP_URL"); then
    note "Email login works."
    KEEP_MAIL=1
  else
    note "$problem Let's try again."
  fi
done

[[ -n $POSTGRES_PASSWORD ]] || POSTGRES_PASSWORD=$(openssl rand -hex 24)
[[ -n $LIFEOS_SECRET ]] || LIFEOS_SECRET=$(openssl rand -hex 32)

(
  umask 077
  cat >"$ENV_FILE.new" <<EOF
# Written by deploy/setup.sh. Keep it private. Changing POSTGRES_PASSWORD locks you out of the existing database.
COMPOSE_FILE=docker-compose.yml:deploy/compose.https.yml
LIFEOS_DOMAIN=$LIFEOS_DOMAIN
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
LIFEOS_SECRET=$LIFEOS_SECRET
SMTP_URL='$SMTP_URL'
MAIL_FROM='$MAIL_FROM'
EOF
)
mv "$ENV_FILE.new" "$ENV_FILE"

# ---------------------------------------------------------------------------
say "Checking that $LIFEOS_DOMAIN points here"
PUBLIC_IP=$(curl -fsS --max-time 10 https://api.ipify.org || true)
DNS_OK=0 RESOLVED=''
[[ -n $PUBLIC_IP ]] && for _ in $(seq 1 12); do
  RESOLVED=$(getent ahostsv4 "$LIFEOS_DOMAIN" | awk '{ print $1; exit }' || true)
  if [[ -n $PUBLIC_IP && $RESOLVED == "$PUBLIC_IP" ]]; then DNS_OK=1; break; fi
  sleep 10
done
if (( DNS_OK )); then
  note "$LIFEOS_DOMAIN → $PUBLIC_IP"
else
  warn "$LIFEOS_DOMAIN points to '${RESOLVED:-nothing}', but this server's public IP is '${PUBLIC_IP:-unknown}'.
         HTTPS won't work until they match. Fix the address, then run: sudo lifeos restart"
fi

# ---------------------------------------------------------------------------
say "Building and starting LifeOS (the first build takes a few minutes)"
cd "$DIR"
docker compose up -d --build --quiet-pull
docker image prune -f >/dev/null

note "Waiting for the server..."
SERVER_OK=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 http://127.0.0.1:8787/v1/health >/dev/null 2>&1; then SERVER_OK=1; break; fi
  sleep 5
done
if (( ! SERVER_OK )); then
  docker compose logs --tail=40 server >&2 || true
  fail "The server didn't start. The log above says why. Fix it, then run this script again."
fi
note "The server is running."

note "Waiting for HTTPS (Caddy is getting a certificate)..."
HTTPS_OK=0
for _ in $(seq 1 36); do
  if curl -fsS --max-time 5 "https://$LIFEOS_DOMAIN/v1/health" >/dev/null 2>&1; then HTTPS_OK=1; break; fi
  sleep 5
done
if (( HTTPS_OK )); then
  note "https://$LIFEOS_DOMAIN is live."
else
  docker compose logs --tail=20 caddy >&2 || true
  warn "https://$LIFEOS_DOMAIN isn't reachable yet. Usually ports 80 and 443 aren't open in Oracle's
         security list (see the guide), or the web address doesn't point here yet. Caddy keeps
         retrying on its own; check again in a minute."
fi

# ---------------------------------------------------------------------------
say "Installing the lifeos command, nightly backups and the DuckDNS updater"
chmod +x "$DIR/deploy/lifeos"
ln -sf "$DIR/deploy/lifeos" /usr/local/bin/lifeos
{
  echo "# LifeOS maintenance, installed by deploy/setup.sh"
  echo "17 3 * * * root /usr/local/bin/lifeos backup >/var/log/lifeos-backup.log 2>&1"
  [[ -f $DUCKDNS_FILE ]] && echo "*/5 * * * * root /usr/local/bin/lifeos duckdns >/dev/null 2>&1"
} >/etc/cron.d/lifeos
chmod 644 /etc/cron.d/lifeos
systemctl enable --now cron >/dev/null 2>&1 || true
note "Backups go to /var/backups/lifeos at 03:17 UTC each night; the last 14 days are kept."

# ---------------------------------------------------------------------------
CODES_FILE=''
if yes_no "Create the founding season and access codes now?" "$( (( PREVIOUS_INSTALL )) && echo N || echo Y)"; then
  ask SEASON_START "Season start date (YYYY-MM-DD)" "$(date -u +%F)"
  ask SEASON_WEEKS "Season length in weeks (6-12)" 6
  ask CODE_COUNT "How many access codes" 30
  ask CODE_DAYS "Codes expire after how many days" 30
  lifeos admin create-season --id founding-1 --name "Founding Season" \
    --starts "$SEASON_START" --weeks "$SEASON_WEEKS" --campaigns founding ||
    warn "Couldn't create the season (it may exist already). Codes will still join founding-1 if it exists."
  CODES_FILE=/root/lifeos-codes-$(date -u +%Y%m%d-%H%M%S).txt
  (umask 077 && lifeos admin issue-codes --campaign founding --count "$CODE_COUNT" --expires-days "$CODE_DAYS" >"$CODES_FILE")
  note "Access codes (each works once):"
  sed 's/^/      /' "$CODES_FILE"
  note "They're also saved in $CODES_FILE"
fi

cat <<EOF

  Done. LifeOS is at https://$LIFEOS_DOMAIN

  Next:
    1. Open https://$LIFEOS_DOMAIN, sign up with one of the codes.
    2. Make yourself an admin:   sudo lifeos admin set-role YOUR-EMAIL admin
    3. Build the Mac app: GitHub → Actions → Companion release → Run workflow,
       with https://$LIFEOS_DOMAIN as the server.

  Run 'lifeos help' for status, logs, updates, backups and more codes.

EOF
