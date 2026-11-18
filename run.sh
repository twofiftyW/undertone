#!/usr/bin/env sh
set -eu
cd -- "$(dirname -- "$0")"
if [ -x "dist/linux/Undertone" ]; then
    exec "./dist/linux/Undertone" "$@"
fi
if [ -x "src-tauri/target/release/undertone" ]; then
    exec "./src-tauri/target/release/undertone" "$@"
fi
printf '%s\n' 'The Linux app has not been built yet. See README.md for build instructions.'
exit 1
