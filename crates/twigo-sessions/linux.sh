#!/usr/bin/env bash
# Usage: crates/twigo-sessions/linux.sh [command]
#
# Runs the crate's tests on Linux in twigo-keyboard's container, with the vi
# and zsh the terminal's tests run, and, as the container is privileged, the
# ones that give a dead shell's pid or a foreground job's group id to
# another process group through ns_last_pid;
# given a command, such as
# `cargo clippy -p twigo-sessions --all-targets -- -D warnings`, it runs that
# instead.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
command=${*:-cargo test -p twigo-sessions && cargo test -p twigo-sessions --lib -- --ignored --test-threads=1 a_terminal_closed_after_its_shell_ended_spares_whoever_has_its_pid_now a_group_that_takes_the_foreground_job_s_id_within_the_grace_is_spared}

docker build -q -t twigo-keyboard-linux "$root/crates/twigo-keyboard/linux" >/dev/null
docker run --rm --privileged \
  -v "$root:/src" \
  -v twigo-keyboard-rustup:/root/.rustup \
  -v twigo-keyboard-registry:/root/.cargo/registry \
  -v twigo-keyboard-target:/target \
  -e CARGO_TARGET_DIR=/target \
  twigo-keyboard-linux \
  sh -c "apt-get update -qq && apt-get install -y -qq --no-install-recommends vim-tiny zsh >/dev/null && rustup toolchain install >/dev/null && $command"
