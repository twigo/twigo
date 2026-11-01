#!/usr/bin/env bash
# Usage: crates/twigo-keyboard/linux/run.sh [command]
#
# Runs a command in an Ubuntu container with the GTK, Wayland and xkbcommon
# that CI installs, by default the crate's tests: the layouts compiled from
# XKB names, the live X11 test under Xvfb, then the live Wayland test under a
# headless sway. Volumes keep the toolchain, the registry and a Linux target
# directory between runs.
set -euo pipefail

root=$(cd "$(dirname "$0")/../../.." && pwd)
tests='cargo test -p twigo-keyboard'
live='xvfb-run -a sh -c '\''TWIGO_TEST_X11_DISPLAY=$DISPLAY cargo test -p twigo-keyboard --test x11 -- --ignored'\'
wayland='crates/twigo-keyboard/linux/wayland.sh cargo test -p twigo-keyboard --test wayland -- --ignored'
command=${*:-$tests && $live && $wayland}

docker build -q -t twigo-keyboard-linux "$root/crates/twigo-keyboard/linux" >/dev/null
docker run --rm \
  -v "$root:/src" \
  -v twigo-keyboard-rustup:/root/.rustup \
  -v twigo-keyboard-registry:/root/.cargo/registry \
  -v twigo-keyboard-target:/target \
  -e CARGO_TARGET_DIR=/target \
  twigo-keyboard-linux \
  sh -c "rustup toolchain install >/dev/null && $command"
