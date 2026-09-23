#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  print -u2 "This pilot builder currently supports Apple Silicon macOS only."
  exit 1
fi

repo_root="$(cd "${0:a:h}/.." && pwd)"
cd "$repo_root"

if [[ -n "$(git status --short)" ]]; then
  print -u2 "The checkout must be clean before building the pilot."
  exit 1
fi

if [[ ! -x node_modules/.bin/vp ]]; then
  print -u2 "Dependencies are missing. Run 'vp i' in this checkout first."
  exit 1
fi

if [[ ! -x "${HOME}/.cargo/bin/cargo" ]]; then
  print -u2 "Rust/Cargo is missing. Install a minimal Rust toolchain and the aarch64-apple-darwin target first."
  exit 1
fi

export PATH="${HOME}/.cargo/bin:${PATH}"

vp test run apps/server/src/jevTurnRouter.test.ts
vp run --filter t3 typecheck
vp lint apps/server/src/jevTurnRouter.ts apps/server/src/jevTurnRouter.test.ts apps/server/src/ws.ts
vp fmt --check apps/server/src/jevTurnRouter.ts apps/server/src/jevTurnRouter.test.ts apps/server/src/ws.ts docs/user/jev-turn-routing.md docs/operations/jev-turn-routing-pilot.md
vp run dist:desktop:dmg:arm64

version="$(node -p "require('./apps/desktop/package.json').version")"
commit="$(git rev-parse HEAD)"
short_commit="${commit[1,12]}"
archive="${repo_root}/release/T3-Code-${version}-arm64.zip"
target="${T3CODE_JEV_APP_PATH:-${HOME}/Applications/T3 Code Jev Standalone ${short_commit}.app}"

if [[ ! -f "$archive" ]]; then
  print -u2 "Expected desktop archive not found: $archive"
  exit 1
fi

if [[ -e "$target" ]]; then
  print -u2 "Refusing to overwrite existing pilot app: $target"
  exit 1
fi

mkdir -p "${target:h}"
stage_dir="$(mktemp -d "${target:h}/t3-jev-stage.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT
ditto -x -k "$archive" "$stage_dir"
mv "$stage_dir/T3 Code (Alpha).app" "$target"

macos_dir="$target/Contents/MacOS"
plist="$target/Contents/Info.plist"
standalone_home="${T3CODE_JEV_HOME:-${HOME}/.t3-jev}"
standalone_user_data="${T3CODE_JEV_USER_DATA_PATH:-${HOME}/Library/Application Support/t3code-jev}"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.benniphx.t3code.jev' "$plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName T3 Code Jev' "$plist"
/usr/libexec/PlistBuddy -c "Add :LSEnvironment:T3CODE_HOME string $standalone_home" "$plist"
/usr/libexec/PlistBuddy -c "Add :LSEnvironment:T3CODE_DESKTOP_USER_DATA_PATH string $standalone_user_data" "$plist"
/usr/libexec/PlistBuddy -c 'Add :LSEnvironment:T3CODE_DISABLE_AUTO_UPDATE string 1' "$plist"

codesign --force --deep --sign - "$target"
scripts/verify-jev-macos-pilot-app.sh "$target" "$standalone_home" "$standalone_user_data"

embedded_commit="$(strings "$target/Contents/Resources/app.asar" | sed -nE 's/.*"t3codeCommitHash": "([0-9a-f]+)".*/\1/p' | head -1)"
if [[ "$embedded_commit" != "$short_commit" ]]; then
  print -u2 "Embedded commit mismatch: expected $short_commit, found ${embedded_commit:-missing}."
  exit 1
fi

print "Built and verified: $target"
print "Commit: $commit"
