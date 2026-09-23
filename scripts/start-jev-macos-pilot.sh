#!/bin/zsh
set -euo pipefail

mode="${1:-}"
app_path="${2:-}"
secret_file="${T3CODE_JEV_SECRET_FILE:-}"
secret_name="${T3CODE_JEV_SECRET_NAME:-}"
log_file="${T3CODE_JEV_LOG_FILE:-${HOME}/Library/Logs/T3 Code Jev Standalone ${mode}.log}"

if [[ "$mode" != "shadow" && "$mode" != "apply" ]]; then
  print -u2 "Usage: T3CODE_JEV_SECRET_FILE=... T3CODE_JEV_SECRET_NAME=... $0 <shadow|apply> <app-path>"
  exit 1
fi

if [[ -z "$app_path" || ! -x "$app_path/Contents/MacOS/T3 Code (Alpha)" ]]; then
  print -u2 "A built T3 Code pilot app path is required."
  exit 1
fi

if [[ -z "$secret_file" || ! -r "$secret_file" || -z "$secret_name" ]]; then
  print -u2 "Set T3CODE_JEV_SECRET_FILE and T3CODE_JEV_SECRET_NAME for the authorized local secret scope."
  exit 1
fi

if ps -axo args= | grep -F '/Contents/MacOS/T3 Code (Alpha)' | grep -v grep >/dev/null; then
  print -u2 "T3 Code is already running. Quit the visible desktop app first."
  exit 1
fi

set +u
source "$secret_file"
jev_key="${(P)secret_name:-}"
set -u

if [[ -z "$jev_key" ]]; then
  print -u2 "$secret_name is missing from the selected local secret scope."
  exit 1
fi

while IFS= read -r loaded_secret_name; do
  unset "$loaded_secret_name"
done < <(
  sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$secret_file"
)

export T3CODE_JEV_MODE="$mode"
export T3CODE_JEV_API_KEY="$jev_key"
export T3CODE_HOME="${T3CODE_JEV_HOME:-${HOME}/.t3-jev}"
export T3CODE_DISABLE_AUTO_UPDATE=1
unset VITE_DEV_SERVER_URL
unset jev_key

mkdir -p "${log_file:h}"
"$app_path/Contents/MacOS/T3 Code (Alpha)" >>"$log_file" 2>&1 &!
print "Started Jev pilot in $mode mode. Log: $log_file"
