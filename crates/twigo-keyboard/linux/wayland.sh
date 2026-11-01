#!/usr/bin/env bash
# Usage: crates/twigo-keyboard/linux/wayland.sh command...
#
# Runs a command against a headless sway with one virtual keyboard, as
# xvfb-run does against Xvfb. WAYLAND_DISPLAY, SWAYSOCK and
# TWIGO_TEST_WAYLAND_DISPLAY name the compositor, whose keyboard the command
# may change through swaymsg.
set -euo pipefail

runtime=$(mktemp -d)
export XDG_RUNTIME_DIR=$runtime
echo 'input type:keyboard xkb_layout us' >"$runtime/config"
WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
  sway -c "$runtime/config" 2>"$runtime/sway.log" &
sway=$!
keyboard=
trap 'kill $sway $keyboard 2>/dev/null || true; rm -rf "$runtime"' EXIT

for _ in $(seq 100); do
  socket=$(find "$runtime" -maxdepth 1 -type s -name 'wayland-*' -print -quit)
  ipc=$(find "$runtime" -maxdepth 1 -type s -name 'sway-ipc.*' -print -quit)
  [ -n "$socket" ] && [ -n "$ipc" ] && break
  sleep 0.1
done
if [ -z "$socket" ] || [ -z "$ipc" ]; then
  cat "$runtime/sway.log" >&2
  exit 1
fi
export WAYLAND_DISPLAY=${socket##*/} SWAYSOCK=$ipc GDK_BACKEND=wayland
export TWIGO_TEST_WAYLAND_DISPLAY=$WAYLAND_DISPLAY

# Headless sway has no input devices: wtype's virtual keyboard, held for an
# hour by its sleep command, gives the seat its keyboard.
wtype -s 3600000 &
keyboard=$!
for _ in $(seq 100); do
  swaymsg -t get_inputs | grep -q '"type": "keyboard"' && break
  sleep 0.1
done

"$@"
