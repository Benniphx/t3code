#!/bin/zsh
set -euo pipefail

app_path="${1:-}"
expected_home="${2:-${HOME}/.t3-jev}"

if [[ -z "$app_path" || ! -d "$app_path/Contents/MacOS" ]]; then
  print -u2 "Usage: $0 <app-path> [expected-t3-home]"
  exit 1
fi

plist="$app_path/Contents/Info.plist"
executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
executable_path="$app_path/Contents/MacOS/$executable_name"
executable_type="$(file -b "$executable_path")"

if [[ "$executable_type" != *"Mach-O 64-bit executable arm64"* ]]; then
  print -u2 "CFBundleExecutable must point directly at the native ARM64 Electron executable, found: $executable_type"
  exit 1
fi

if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" != "com.benniphx.t3code.jev" ]]; then
  print -u2 "Standalone bundle identifier is missing."
  exit 1
fi

if [[ "$(/usr/libexec/PlistBuddy -c 'Print :LSEnvironment:T3CODE_HOME' "$plist")" != "$expected_home" ]]; then
  print -u2 "Standalone T3 home is missing from LSEnvironment."
  exit 1
fi

if [[ "$(/usr/libexec/PlistBuddy -c 'Print :LSEnvironment:T3CODE_DISABLE_AUTO_UPDATE' "$plist")" != "1" ]]; then
  print -u2 "Standalone auto-update guard is missing from LSEnvironment."
  exit 1
fi

codesign --verify --deep --strict "$app_path"
print "Verified standalone native app: $app_path"
