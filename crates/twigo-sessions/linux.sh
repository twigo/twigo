#!/usr/bin/env bash
# Usage: crates/twigo-sessions/linux.sh [command]
#
# Runs the crate's tests on Linux in twigo-keyboard's container, with the vi
# and zsh the terminal's tests run; given a command, such as
# `cargo clippy -p twigo-sessions --all-targets -- -D warnings`, it runs that
# instead.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
command=${*:-cargo test -p twigo-sessions}

docker build -q -t twigo-keyboard-linux "$root/crates/twigo-keyboard/linux" >/dev/null
docker run --rm \
  -v "$root:/src" \
  -v twigo-keyboard-rustup:/root/.rustup \
  -v twigo-keyboard-registry:/root/.cargo/registry \
  -v twigo-keyboard-target:/target \
  -e CARGO_TARGET_DIR=/target \
  twigo-keyboard-linux \
  sh -c "apt-get update -qq && apt-get install -y -qq --no-install-recommends vim-tiny zsh >/dev/null && rustup toolchain install >/dev/null && $command"
