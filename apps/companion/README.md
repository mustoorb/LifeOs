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

- No upload yet. Export writes a file that the future account service will accept.
- No launch-at-login toggle yet. It should be opt-in, so it belongs on the consent screen.
- `npm audit` reports a build-time advisory in electron-builder's download cache (`http-cache-semantics` via `got`). No patched version exists, and none of it ships in the app.
