#!/usr/bin/env bash
# Usage: crates/twigo-keyboard/linux/wayland.sh command...
#
# Runs a command against a headless sway, as xvfb-run does against Xvfb.
# WAYLAND_DISPLAY and TWIGO_TEST_WAYLAND_DISPLAY name the compositor, which
# has no input devices: the command gives its seat a keyboard of its own, a
# virtual keyboard whose keymap and group it sets.
set -euo pipefail

runtime=$(mktemp -d)
export XDG_RUNTIME_DIR=$runtime
: >"$runtime/config"
WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
  sway -c "$runtime/config" 2>"$runtime/sway.log" &
sway=$!
trap 'kill $sway 2>/dev/null || true; rm -rf "$runtime"' EXIT

for _ in $(seq 100); do
  socket=$(find "$runtime" -maxdepth 1 -type s -name 'wayland-*' -print -quit)
  [ -n "$socket" ] && break
  sleep 0.1
done
if [ -z "$socket" ]; then
  cat "$runtime/sway.log" >&2
  exit 1
fi
export WAYLAND_DISPLAY=${socket##*/} GDK_BACKEND=wayland
export TWIGO_TEST_WAYLAND_DISPLAY=$WAYLAND_DISPLAY

"$@"
