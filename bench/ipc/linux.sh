#!/usr/bin/env bash
# Usage: bench/ipc/linux.sh cost|frames [runs, default 1]
#
# Runs bench/ipc/run.sh on WebKitGTK in an Ubuntu container under Xvfb.
# Volumes keep the toolchain, the registry and a Linux target directory
# between runs; the results land in $TWIGO_BENCH_DIR/ipc on the host.
set -euo pipefail

[ $# -ge 1 ] || {
  echo "usage: $0 cost|frames [runs]" >&2
  exit 2
}

root=$(cd "$(dirname "$0")/../.." && pwd)
results=${TWIGO_BENCH_DIR:?set TWIGO_BENCH_DIR to a temporary directory}
mkdir -p "$results"

docker build -t twigo-bench-ipc "$root/bench/ipc"
docker run --rm \
  -v "$root:/src" \
  -v "$results:/results" \
  -v twigo-bench-ipc-rustup:/root/.rustup \
  -v twigo-bench-ipc-registry:/root/.cargo/registry \
  -v twigo-bench-ipc-target:/target \
  -e CARGO_TARGET_DIR=/target \
  -e TWIGO_BENCH_DIR=/results \
  twigo-bench-ipc \
  sh -c 'rustup toolchain install && xvfb-run -a bench/ipc/run.sh "$@"' sh "$@"
