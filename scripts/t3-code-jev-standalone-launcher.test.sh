#!/bin/zsh
set -euo pipefail

script_dir="${0:a:h}"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

cp "$script_dir/t3-code-jev-standalone-launcher.sh" "$fixture_dir/T3 Code (Alpha)"
chmod +x "$fixture_dir/T3 Code (Alpha)"

cat >"$fixture_dir/T3 Code Jev Backend" <<'EOF'
#!/bin/zsh
print -r -- "${T3CODE_HOME}|${T3CODE_DISABLE_AUTO_UPDATE}|${VITE_DEV_SERVER_URL-unset}|$*"
EOF
chmod +x "$fixture_dir/T3 Code Jev Backend"

default_output="$(HOME=/Users/tester VITE_DEV_SERVER_URL=http://remote.invalid "$fixture_dir/T3 Code (Alpha)" --probe default)"
[[ "$default_output" == "/Users/tester/.t3-jev|1|unset|--probe default" ]]

override_output="$(HOME=/Users/tester T3CODE_JEV_HOME=/tmp/jev-home "$fixture_dir/T3 Code (Alpha)" --probe override)"
[[ "$override_output" == "/tmp/jev-home|1|unset|--probe override" ]]

print "Standalone launcher regression passed."
