# Jev turn-routing desktop pilot

This runbook builds and starts the experimental Jev router on Apple Silicon
macOS without replacing the installed T3 Code application. It is intended for
trusted local testing of this branch.

## Build

Use a clean checkout of `experiment/jev-turn-router`. Install the repository
dependencies with `vp i` if needed. The packaging step also requires a minimal
Rust toolchain with the `aarch64-apple-darwin` target.

```bash
scripts/build-jev-macos-pilot.sh
```

The script runs the focused router tests, server typecheck, targeted lint and
format checks, builds the ARM64 DMG/ZIP, installs a separate ad-hoc-signed app
under `~/Applications`, and verifies that its embedded commit matches `HEAD`.
The app uses its own bundle identity and a signed `LSEnvironment` entry for the
`~/.t3-jev` state root, so launching it directly from Finder starts the bundled
local backend instead of inheriting the installed app's saved Server Connector.
The native Electron executable remains the bundle executable; wrapping or
renaming it makes Electron abort during `ElectronMain` on macOS. `CFBundleName`
also remains aligned with the packaged Electron helper-app names; changing only
the display name avoids Electron's `Unable to find helper app` fatal startup
check. The builder verifies both package invariants before succeeding. It
refuses to overwrite an existing pilot app. Set `T3CODE_JEV_APP_PATH` to choose
another unused destination, or `T3CODE_JEV_HOME` to choose another isolated
state root while building and starting it.

## Configure the local secret scope

The API key must already exist in a machine-local, permission-restricted secret
file. Do not put the value in this checkout, a command argument, a launcher,
T3 settings, logs, or documentation.

The launcher is intentionally generic. Point it at the authorized secret file
and variable name for that machine:

```bash
export T3CODE_JEV_SECRET_FILE="$HOME/.secrets/private.env"
export T3CODE_JEV_SECRET_NAME="AI_COMMAND_JEV_KEY"
```

That example is only for an authorized private machine. A work computer must
use its separately approved work-only secret scope and documented variable
name. Never copy or use the private key on a work computer. If no work-only Jev
credential is documented and authorized, stop before launching the pilot.

## Start on the visible local desktop backend

Finish the current turn and quit the visible T3 Code desktop app. Do not stop,
replace, or use a T3 background service, and do not create a substitute thread
on another environment. Then start the separate build:

```bash
scripts/start-jev-macos-pilot.sh shadow "$HOME/Applications/T3 Code Jev Standalone <commit>.app"
```

Keep the existing project and thread on the visible `Local` environment.
Confirm that a new turn creates a `Jev shadow` activity containing the tier,
confidence, latency, token usage, original model, and recommendation. Shadow
does not change the turn model.

After enough correct shadow recommendations, quit the desktop app and restart
the same build in apply mode:

```bash
scripts/start-jev-macos-pilot.sh apply "$HOME/Applications/T3 Code Jev Standalone <commit>.app"
```

Apply routing is per turn, not per thread. Confidence of at least `0.85`
changes only that turn to the tier-mapped model. Lower confidence, timeout,
invalid responses, API failures, or missing configuration keep the composer
model.

## Verify and roll back

The activity is the authoritative visible record. The composer continues to
show its saved selection because routing does not rewrite the thread default.
Runtime output goes to the path printed by the launcher.

For an immediate routing rollback, quit the desktop app and start the pilot
with `T3CODE_JEV_MODE=off` through an ordinary environment-aware launch, or
reopen the unchanged installed T3 Code app. The router has no database
migration, so projects, threads, pairings, and saved model selections remain
unchanged.
