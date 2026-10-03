# LifeOS Companion (macOS)

The PROMETHEE desktop companion (blueprint §18). It is a menu-bar app that records which
app is in front, only after the user allows it. It keeps those records on the Mac and turns
time in apps the user has categorized into activity for ECLIPSE.

## How it works

```
lifeos-frontmost (Swift)        Electron main process                      Window
NSWorkspace frontmost app  ──►  HelperDetector ─┐
                                powerMonitor idle ├─► CompanionService ◄── IPC ──► consent, timeline,
                                lock / sleep  ────┘     │  SampleBuffer          app categories,
                                                        │  LocalStore            privacy controls
                                Tray (menu bar) ◄───────┘  @lifeos/promethee
```

- **`native/FrontmostApp.swift`** is a tiny helper that prints `{"bundleId","name"}` whenever the frontmost app changes. It reads only `NSWorkspace.frontmostApplication`, which needs **no Accessibility or Screen Recording permission** and can't see window titles or content.
- **`src/core/`** holds all of the behaviour. None of it depends on Electron, and it is unit tested.
  - `service.ts`: consent, pause, focus sessions, sampling, the user's data controls.
  - `sampler.ts`: buffers the last *idle-threshold* seconds of samples. When macOS reports idleness, samples from the idle stretch are dropped instead of counted. Idle time is never stored.
  - `store.ts`: one JSON-lines file per local day, in a `0700` directory with `0600` files. Writes are atomic.
  - `timeline.ts`: builds sessions with `aggregateDesktopSamples` and `applyFocusBlocks` from `@lifeos/promethee`.
  - `export.ts`: the only data meant to leave the Mac. It contains normalized `ActivityEvent`s with categories and durations, never bundle ids or app names.
- **`src/main/`** is the thin Electron shell: tray, window, IPC, and the native-helper supervisor.
- **`src/renderer/`** is a framework-free page. It runs sandboxed with context isolation and a strict CSP, and renders every string as text.

### Account and upload

`src/core/account.ts` and `account-client.ts` connect the companion to the
[LifeOS server](../server/README.md). All network calls run in the main process through
`net.fetch`. The window has no network access.

- **Signing in** uses an emailed six-digit code. If no account uses that email yet, the same card asks for an access code, a name, a date of birth (for the 18+ check, not stored) and a country. Signing in uploads nothing by itself.
- **The session token** is encrypted with `safeStorage`, which is backed by the macOS Keychain. If secure storage is unavailable, the token stays in memory, the user signs in again after quitting, and the app says so. Linux's plaintext `basic_text` keyring counts as unavailable.
- **Uploading is a separate switch.** Turning it on records `desktop_activity` consent on the account. Turning it off records the revocation, at once or at the next sync if offline.
- **Only settled sessions are uploaded.** A session waits until it can no longer change: the merge gap plus the idle threshold plus 5 minutes after it ends, since server events are immutable. Uploads start with the day upload was turned on, run every 15 minutes and on wake, and use a watermark so nothing is sent twice.
- **Deleting on the Mac also deletes on the account.** This covers the last hour, a day, everything, or turning tracking off with deletion, once anything may have been uploaded. Deletions are queued and retried if the server can't be reached.
- **Each sync confirms the session.** If the session was revoked elsewhere, the companion signs out and says why.
- The server URL is set at build time with `LIFEOS_SERVER_URL`. It must be HTTPS except for localhost. Development builds can override it at runtime.

What the account receives: categories, start and end times, active seconds and focus tags.
It never receives app bundle ids, app names or raw samples.

### Privacy behaviour

| Behaviour | Where |
|---|---|
| Nothing is recorded before consent. Revoking discards buffered samples and can delete everything. | `CompanionService.grantConsent` / `revokeConsent` |
| Unmapped apps never produce sessions. Their raw samples stay on the Mac so the user can decide what to do with them. | `timeline.ts`, `settings.ts` |
| Excluded apps are never recorded, not even their names. Excluding an app deletes its history. | `SampleBuffer`, `setExcluded` |
| Pause (30 min, 1 h, until tomorrow, until resumed) survives restarts. | `pauseFor`, `state.json` |
| "Delete the last hour", "Delete this day" and "Delete everything" are confirmed by a native dialog the page can't bypass. | `ipc.ts` |
| Raw samples are deleted after 30 days. | `prune` |
| The window's IPC only answers the bundled page. | `assertTrustedSender` |
| Locked screen, sleep and the companion's own window are not activity. | `main.ts` |

## Develop

```sh
npm install                       # from the repo root
npm run build:helper -w @lifeos/companion   # macOS only: builds build/bin/lifeos-frontmost
npm start -w @lifeos/companion    # builds and launches
```

Off macOS, or without the helper, set a stand-in frontmost app:

```sh
LIFEOS_DEV_FRONTMOST="com.apple.FinalCut:Final Cut Pro" LIFEOS_DATA_DIR=/tmp/lifeos npm start -w @lifeos/companion
```

To sign in, run the [server](../server/README.md) locally. The default server URL is
`http://127.0.0.1:8787`; point elsewhere with `LIFEOS_SERVER_URL`. Sign-in codes appear in
the server's log.

`LIFEOS_DEV_FRONTMOST` and `LIFEOS_DATA_DIR` are ignored in packaged builds. Without either
the helper or the stand-in, the companion runs but reports "app detection unavailable" and
records nothing.

## Package

```sh
npm run dist:mac -w @lifeos/companion
```

`dist:mac` produces arm64 and x64 `.dmg` and `.zip` files in `release/`, with the hardened
runtime and the single entitlement Electron needs (`allow-jit`). To sign and notarize,
provide a Developer ID certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`) and Apple notarization
credentials (for example `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), which
electron-builder reads from the environment. CI builds an unsigned bundle to check
packaging. Signing has not been exercised yet.

## Known gaps

- Category changes and app exclusions apply to sessions not yet uploaded. Already-uploaded sessions keep their category, though deleting a time range removes them from the account.
- No launch-at-login toggle yet. It should be opt-in, so it belongs on the consent screen.
- `npm audit` reports a build-time advisory in electron-builder's download cache (`http-cache-semantics` via `got`). No patched version exists, and none of it ships in the app.
