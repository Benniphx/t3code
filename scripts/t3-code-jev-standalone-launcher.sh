#!/bin/zsh
set -euo pipefail

real_executable="${0:a:h}/T3 Code Jev Backend"

if [[ ! -x "$real_executable" ]]; then
  print -u2 "The bundled Jev backend executable is missing: $real_executable"
  exit 1
fi

# Keep the pilot independent from the installed T3 app and from any saved
# connector catalog. The packaged desktop app will start its embedded backend
# against this state root even when launched directly from Finder.
export T3CODE_HOME="${T3CODE_JEV_HOME:-${HOME}/.t3-jev}"
export T3CODE_DISABLE_AUTO_UPDATE=1
unset VITE_DEV_SERVER_URL

exec "$real_executable" "$@"
