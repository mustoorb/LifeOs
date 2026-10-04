#!/bin/bash
# Runs LifeOS on your Mac: Docker (OrbStack or Docker Desktop) runs the server and its database,
# and Tailscale Funnel gives it a public HTTPS address. See docs/deploy-mac.md.
#
#   curl -fsSL https://raw.githubusercontent.com/mustoorb/LifeOs/main/deploy/mac.sh -o mac.sh && bash mac.sh
#
# Safe to run again: it keeps the database password and secret, and offers your previous answers.
# Written for the bash 3.2 that ships with macOS.
set -euo pipefail

REPO=${LIFEOS_REPO:-mustoorb/LifeOs}
BRANCH=${LIFEOS_BRANCH:-main}
DIR=${LIFEOS_DIR:-$HOME/LifeOS}
ENV_FILE=$DIR/.env
PORT=8787
export PATH="$HOME/.orbstack/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\n\033[33mWarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ask VAR "Question" [default]
ask() {
  local var=$1 prompt=$2 default=${3:-} answer
  if [[ -n $default ]]; then prompt="$prompt [$default]"; fi
  read -r -p "    $prompt: " answer </dev/tty
  printf -v "$var" '%s' "${answer:-$default}"
}

# ask_secret VAR "Question" [current value, kept when the answer is empty]
ask_secret() {
  local var=$1 prompt=$2 current=${3:-} answer
  if [[ -n $current ]]; then prompt="$prompt (press Enter to keep the current one)"; fi
  read -r -s -p "    $prompt: " answer </dev/tty
  echo
  printf -v "$var" '%s' "${answer:-$current}"
}

yes_no() { # yes_no "Question" Y|N
  local reply # not "answer": ask() has a local of that name, which would shadow ours
  ask reply "$1 (y/n)" "$2"
  [[ $reply == [Yy]* ]]
}

# ask_matching VAR "Question" default regex "what to type": asks again until the answer matches.
ask_matching() {
  local var=$1 prompt=$2 default=$3 pattern=$4 hint=$5 reply
  while true; do
    ask reply "$prompt" "$default"
    if [[ $reply =~ $pattern ]]; then
      printf -v "$var" '%s' "$reply"
      return 0
    fi
    note "Please type $hint, or press Enter for $default."
  done
}

urlencode() {
  local s=$1 out='' c i
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [a-zA-Z0-9.~_-]) out="$out$c" ;;
      *) out="$out$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# Logs in to the SMTP server in $1, the way the LifeOS server will, then sends a harmless NOOP.
# curl decodes the credentials in the URL.
test_smtp() {
  local url=$1 code=0
  local extra=()
  if [[ $url == smtp://* ]]; then extra=(--ssl-reqd); fi
  curl -sS --max-time 20 -X NOOP ${extra[@]+"${extra[@]}"} "$url" >/dev/null 2>&1 || code=$?
  case $code in
    0) return 0 ;;
    67) echo "The mail server rejected the address or password." ;;
    *) echo "Couldn't reach the mail server (curl error $code)." ;;
  esac
  return 1
}

# Reads a value from `tailscale status --json`: plutil ships with macOS 12+, grep is the fallback.
json_get() { # json_get "$json" Key.Path
  local value
  value=$(printf '%s' "$1" | plutil -extract "$2" raw -o - - 2>/dev/null) ||
    value=$(printf '%s' "$1" | grep -m1 "\"${2##*.}\"" | sed -E 's/.*: *"([^"]*)".*/\1/')
  printf '%s' "$value"
}

[[ $(uname) == Darwin ]] || fail "This script is for macOS. On a Linux server, use deploy/setup.sh."

PREVIOUS_INSTALL=0
[[ -f $ENV_FILE ]] && PREVIOUS_INSTALL=1

cat <<EOF

  LifeOS on your Mac
  ------------------
  This installs LifeOS in $DIR, runs it in Docker, and makes it public over
  HTTPS with Tailscale Funnel. It takes about 10 minutes.

EOF

# ---------------------------------------------------------------------------
say "Checking Docker and Tailscale"
command -v docker >/dev/null || fail "Docker isn't installed. Install OrbStack from https://orbstack.dev, open it once, then run this again."
docker info >/dev/null 2>&1 || fail "Docker isn't running. Open OrbStack, wait until it says it's running, then run this again."
docker compose version >/dev/null 2>&1 || fail "Docker Compose is missing. Update OrbStack, then run this again."
note "Docker is running."

TS=${TAILSCALE:-$(command -v tailscale || true)}
if [[ -z $TS && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
[[ -n $TS ]] || fail "Tailscale isn't installed. Install it from https://tailscale.com/download/mac, sign in, then run this again."
TS_STATUS=$("$TS" status --json 2>/dev/null || true)
[[ $(json_get "$TS_STATUS" BackendState) == Running ]] ||
  fail "Tailscale isn't connected. Click the Tailscale icon in the menu bar, sign in or click Connect, then run this again."
LIFEOS_DOMAIN=$(json_get "$TS_STATUS" Self.DNSName)
LIFEOS_DOMAIN=${LIFEOS_DOMAIN%.}
[[ $LIFEOS_DOMAIN == *.ts.net ]] ||
  fail "Couldn't find this Mac's Tailscale name. Turn on MagicDNS at https://login.tailscale.com/admin/dns, then run this again."
note "Tailscale is connected. Your address will be https://$LIFEOS_DOMAIN"

# ---------------------------------------------------------------------------
say "Getting the LifeOS code"
mkdir -p "$DIR"
if [[ -d $DIR/.git ]]; then
  git -C "$DIR" pull -q --ff-only
else
  TMP=$(mktemp -d)
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$TMP"
  rsync -a --delete --exclude .env "$TMP"/*/ "$DIR"/
  rm -rf "$TMP"
fi
chmod +x "$DIR/deploy/lifeos"
note "Saved in $DIR"

# ---------------------------------------------------------------------------
say "Settings"
POSTGRES_PASSWORD='' LIFEOS_SECRET='' SMTP_URL='' MAIL_FROM=''
if (( PREVIOUS_INSTALL )); then
  CURRENT_DOMAIN=$LIFEOS_DOMAIN
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  LIFEOS_DOMAIN=$CURRENT_DOMAIN
fi

KEEP_MAIL=0
if [[ -n $SMTP_URL ]]; then
  note "Email is set up to send from: $MAIL_FROM"
  if yes_no "Keep these email settings?" Y; then KEEP_MAIL=1; fi
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
# Written by deploy/mac.sh. Keep it private. Changing POSTGRES_PASSWORD locks you out of the existing database.
COMPOSE_FILE=docker-compose.yml
LIFEOS_DOMAIN=$LIFEOS_DOMAIN
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
LIFEOS_SECRET=$LIFEOS_SECRET
SMTP_URL='$SMTP_URL'
MAIL_FROM='$MAIL_FROM'
EOF
)
mv "$ENV_FILE.new" "$ENV_FILE"

# ---------------------------------------------------------------------------
say "Building and starting LifeOS (the first build takes a few minutes)"
cd "$DIR"
docker compose up -d --build --quiet-pull
docker image prune -f >/dev/null

note "Waiting for the server..."
SERVER_OK=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then SERVER_OK=1; break; fi
  sleep 5
done
if (( ! SERVER_OK )); then
  docker compose logs --tail=40 server >&2 || true
  fail "The server didn't start. The log above says why. Fix it, then run this script again."
fi
note "The server is running."

# ---------------------------------------------------------------------------
say "Making it public with Tailscale Funnel"
note "If Tailscale prints a link, open it, approve Funnel (and HTTPS) for this Mac, then come back here."
"$TS" funnel --bg "$PORT"

note "Waiting for https://$LIFEOS_DOMAIN (the first certificate can take a minute)..."
PUBLIC_OK=0
for _ in $(seq 1 36); do
  if curl -fsS --max-time 10 "https://$LIFEOS_DOMAIN/v1/health" >/dev/null 2>&1; then PUBLIC_OK=1; break; fi
  sleep 5
done
if (( PUBLIC_OK )); then
  note "https://$LIFEOS_DOMAIN is live."
else
  warn "https://$LIFEOS_DOMAIN isn't answering yet. Run '$TS funnel status' to check Funnel is on,
         then try the address again in a minute."
fi

# ---------------------------------------------------------------------------
say "Backups and the lifeos command"
CRON_LINE="17 * * * * \"$DIR/deploy/lifeos\" backup --if-due >>\"$HOME/LifeOS-backups.log\" 2>&1"
if ! crontab -l 2>/dev/null | grep -qF "deploy/lifeos backup"; then
  { crontab -l 2>/dev/null || true; echo "$CRON_LINE"; } | crontab - ||
    warn "Couldn't schedule backups. Run '$DIR/deploy/lifeos backup' now and then instead."
fi
note "A backup is saved to ~/LifeOS-backups once a day while the Mac is awake (14 days kept)."

if ! grep -qs "alias lifeos=" "$HOME/.zshrc"; then
  echo "alias lifeos=\"$DIR/deploy/lifeos\"" >>"$HOME/.zshrc"
fi
note "Open a new Terminal window to use the 'lifeos' command (try: lifeos status)."

say "Keeping LifeOS reachable"
note "LifeOS is only online while this Mac is on, awake and connected."
if yes_no "Stop this Mac from sleeping while it's plugged in? (asks for your Mac password)" Y; then
  if sudo pmset -c sleep 0; then
    note "Done. The screen can still turn off; the Mac stays awake on power."
  else
    warn "Couldn't change the sleep setting. Use System Settings → Battery (or Energy) instead."
  fi
fi

# ---------------------------------------------------------------------------
CODES_FILE=''
CREATE_DEFAULT=Y
if (( PREVIOUS_INSTALL )); then CREATE_DEFAULT=N; fi
if yes_no "Create the founding season and access codes now?" "$CREATE_DEFAULT"; then
  ask_matching SEASON_START "Season start date (YYYY-MM-DD)" "$(date -u +%F)" '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' "a date like $(date -u +%F)"
  ask_matching SEASON_WEEKS "Season length in weeks (6-12)" 6 '^([6-9]|1[0-2])$' "a number from 6 to 12"
  ask_matching CODE_COUNT "How many access codes" 30 '^[1-9][0-9]{0,2}$' "a number from 1 to 999"
  ask_matching CODE_DAYS "Codes expire after how many days" 30 '^[1-9][0-9]{0,2}$' "a number of days, like 30"
  "$DIR/deploy/lifeos" admin create-season --id founding-1 --name "Founding Season" \
    --starts "$SEASON_START" --weeks "$SEASON_WEEKS" --campaigns founding ||
    warn "Couldn't create the season (it may exist already). Codes will still join founding-1 if it exists."
  CODES_FILE=$HOME/LifeOS-codes-$(date -u +%Y%m%d-%H%M%S).txt
  (umask 077 && "$DIR/deploy/lifeos" admin issue-codes --campaign founding --count "$CODE_COUNT" --expires-days "$CODE_DAYS" >"$CODES_FILE")
  note "Access codes (each works once):"
  sed 's/^/      /' "$CODES_FILE"
  note "They're also saved in $CODES_FILE"
fi

cat <<EOF

  Done. LifeOS is at https://$LIFEOS_DOMAIN

  Next:
    1. Open https://$LIFEOS_DOMAIN and sign up with one of the codes.
    2. Make yourself an admin:   $DIR/deploy/lifeos admin set-role YOUR-EMAIL admin
    3. Build the Mac app: GitHub → Actions → Companion release → Run workflow,
       with https://$LIFEOS_DOMAIN as the server.

  Run '$DIR/deploy/lifeos help' for status, logs, updates, backups and more codes.

EOF
