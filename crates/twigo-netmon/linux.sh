#!/usr/bin/env bash
# Usage: crates/twigo-netmon/linux.sh
#
# Runs the crate's tests on Linux in twigo-keyboard's container, the ignored
# ones included: a dbus-daemon of the test's own stands in for logind, and
# CAP_NET_ADMIN lets the netlink test add a dummy link to the container's
# network.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
docker build -q -t twigo-keyboard-linux "$root/crates/twigo-keyboard/linux" >/dev/null
docker run --rm --cap-add NET_ADMIN \
  -v "$root:/src" \
  -v twigo-keyboard-rustup:/root/.rustup \
  -v twigo-keyboard-registry:/root/.cargo/registry \
  -v twigo-keyboard-target:/target \
  -e CARGO_TARGET_DIR=/target \
  twigo-keyboard-linux \
  sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends dbus iproute2 >/dev/null && rustup toolchain install >/dev/null && cargo test -p twigo-netmon -- --include-ignored'
