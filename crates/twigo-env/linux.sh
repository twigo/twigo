#!/usr/bin/env bash
# Usage: crates/twigo-env/linux.sh [command]
#
# Runs the crate's tests on Linux in twigo-keyboard's container, with the
# zsh, fish and pwsh a terminal's shells are tested with: zsh and fish from
# Ubuntu, pwsh from PowerShell's release for the container's architecture;
# given a command, such as
# `cargo clippy -p twigo-env --all-targets -- -D warnings`, it runs that
# instead.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
command=${*:-cargo test -p twigo-env}
pwsh=7.7.0

docker build -q -t twigo-keyboard-linux "$root/crates/twigo-keyboard/linux" >/dev/null
docker run --rm \
  -v "$root:/src" \
  -v twigo-keyboard-rustup:/root/.rustup \
  -v twigo-keyboard-registry:/root/.cargo/registry \
  -v twigo-keyboard-target:/target \
  -e CARGO_TARGET_DIR=/target \
  twigo-keyboard-linux \
  sh -c "apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends fish libicu78 zsh >/dev/null \
    && arch=\$(uname -m | sed 's/aarch64/arm64/; s/x86_64/x64/') \
    && mkdir -p /opt/pwsh \
    && curl -fsSL https://github.com/PowerShell/PowerShell/releases/download/v$pwsh/powershell-$pwsh-linux-\$arch.tar.gz | tar -xz -C /opt/pwsh \
    && ln -s /opt/pwsh/pwsh /usr/bin/pwsh \
    && rustup toolchain install >/dev/null \
    && $command"
