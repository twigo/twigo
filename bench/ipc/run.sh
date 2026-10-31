#!/usr/bin/env bash
# Usage: bench/ipc/run.sh cost|frames [runs, default 1]
#
# Builds the IPC bench without and with the isolation pattern and runs both,
# alternating their order between runs. `cost` builds in release. Each run
# leaves <mode>-<pattern>-<run>.json and .log in $TWIGO_BENCH_DIR/ipc, and the
# script stops at the first run whose checks fail.
set -euo pipefail

usage() {
  echo "usage: $0 cost|frames [runs]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
mode=$1
runs=${2:-1}
case "$runs" in
  '' | *[!0-9]* | 0*) usage ;;
esac
case "$mode" in
  cost) profile=release ;;
  frames) profile=dev ;;
  *) usage ;;
esac

root=$(cd "$(dirname "$0")/../.." && pwd)
target=${CARGO_TARGET_DIR:-$root/target}
out=${TWIGO_BENCH_DIR:?set TWIGO_BENCH_DIR to a temporary directory}/ipc
mkdir -p "$out"

for pattern in brownfield isolation; do
  cargo build --manifest-path "$root/Cargo.toml" --profile "$profile" -p "twigo-bench-ipc-$pattern"
done
[ "$profile" = dev ] && dir=debug || dir=$profile

run() {
  local pattern=$1 n=$2
  local name="$out/$mode-$pattern-$n"
  echo "run $n, $pattern" >&2
  if ! TWIGO_BENCH_IPC=$mode "$target/$dir/twigo-bench-ipc-$pattern" >"$name.json" 2>"$name.log"; then
    cat "$name.log" >&2
    exit 1
  fi
}

for n in $(seq 1 "$runs"); do
  if [ $((n % 2)) -eq 1 ]; then
    run brownfield "$n"
    run isolation "$n"
  else
    run isolation "$n"
    run brownfield "$n"
  fi
done
echo "$out" >&2
