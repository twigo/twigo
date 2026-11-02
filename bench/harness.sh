#!/usr/bin/env bash
# Usage: bench/harness.sh [kubeconfig]
#
# ARCHITECTURE 3.8's six metrics at 5k pods, on macOS. Builds the app's bench mode in release,
# runs the churn generator at 100 changes/s against a kwok cluster, launches the app with
# TWIGO_BENCH and the cluster's kubeconfig as TWIGO_KUBECONFIG, samples its memory with the pod
# list open and its CPU with the window hidden, and prints the report. Without a kubeconfig it creates the cluster (bench/cluster.sh up bench,
# bench/pods.sh 5000) and deletes it at the end; a given one must hold the 5,000 pods already.
# report.json and the files it is built from land in $TWIGO_BENCH_DIR/harness.
set -euo pipefail

PODS=5000
RATE=100
SETTLE=10
MEMORY_SAMPLES=5
MEMORY_EVERY=2
IDLE_SETTLE=5
IDLE_SAMPLE=30

usage() {
  echo "usage: $0 [kubeconfig]" >&2
  exit 2
}

[ $# -le 1 ] || usage
[ "$(uname -s)" = Darwin ] || { echo "the harness runs on macOS only so far" >&2; exit 2; }
root=$(cd "$(dirname "$0")/.." && pwd)
base=${TWIGO_BENCH_DIR:?set TWIGO_BENCH_DIR to a temporary directory}
out=$base/harness
target=${CARGO_TARGET_DIR:-$root/target}
tool=$target/release/twigo-bench
rm -rf "$out"
mkdir -p "$out"

created=
app=
churn=
stop_wait() {
  i=0
  while kill -0 "$1" 2>/dev/null; do
    [ "$i" -ge 15 ] && return 1
    i=$((i + 1))
    sleep 1
  done
}
cleanup() {
  # A background job inherits SIGINT ignored until tokio installs its handler,
  # so a churn stuck before that only stops on SIGTERM.
  if [ -n "$churn" ]; then
    kill -INT "$churn" 2>/dev/null || true
    stop_wait "$churn" || kill -TERM "$churn" 2>/dev/null || true
    wait "$churn" 2>/dev/null || true
  fi
  if [ -n "$app" ]; then kill "$app" 2>/dev/null || true; fi
  if [ -n "$created" ]; then "$root/bench/cluster.sh" down bench >&2 || true; fi
}
trap cleanup EXIT

if [ $# -eq 1 ]; then
  kubeconfig=$1
else
  created=1
  "$root/bench/cluster.sh" up bench 1.37 >&2
  kubeconfig=$base/bench/kubeconfig
  "$root/bench/pods.sh" "$kubeconfig" "$PODS" >&2
fi

echo "building in release" >&2
cargo build --manifest-path "$root/Cargo.toml" --release -p twigo-bench >&2
if ! (cd "$root" && pnpm tauri build --no-bundle --features bench \
  --config src-tauri/tauri.bench.conf.json) >"$out/build.log" 2>&1; then
  tail -40 "$out/build.log" >&2
  exit 1
fi

commit=$(git -C "$root" rev-parse --short HEAD)
git -C "$root" diff --quiet HEAD || commit="$commit, with uncommitted changes"
memory=$(($(sysctl -n hw.memsize) / 1073741824))
cpu=$(sysctl -n machdep.cpu.brand_string)
os_version=$(sw_vers -productVersion)
date=$(date -u +%Y-%m-%dT%H:%MZ)
jq -n --arg date "$date" --arg machine "$cpu, $memory GB" --arg os "macOS $os_version" \
  --arg commit "$commit" --arg build release \
  '{date: $date, machine: $machine, os: $os, commit: $commit, build: $build}' >"$out/run.json"

"$tool" churn --kubeconfig "$kubeconfig" --rate "$RATE" --log "$out/churn.jsonl" \
  >"$out/churn.json" 2>"$out/churn.log" &
churn=$!

churn_alive() {
  if ! kill -0 "$churn" 2>/dev/null; then
    echo "the churn generator exited" >&2
    tail -20 "$out/churn.log" >&2
    exit 1
  fi
}

no_failure() {
  if [ -e "$out/failure.json" ]; then
    cat "$out/failure.json" >&2
    echo >&2
    exit 1
  fi
}

left=30
until [ -s "$out/churn.jsonl" ]; do
  churn_alive
  left=$((left - 1))
  if [ "$left" -le 0 ]; then
    echo "the churn generator logged no change within 30 s" >&2
    exit 1
  fi
  sleep 1
done

# The bench build has an identifier of its own, so its window state and its state start fresh
# here and the user's Twigo keeps its own and its single-instance lock: a pod list the last run
# left open would subscribe before the driver opens it.
bench_data="$HOME/Library/Application Support/io.twigo.ide.bench"
rm -f "$bench_data/.window-state.json" "$bench_data/state.json"
TWIGO_BENCH=$out TWIGO_KUBECONFIG=$kubeconfig "$tool" launch "$target/release/twigo" \
  >"$out/app.log" 2>&1 &
app=$!

# The webview writes failure.json and then idle.json, so a failure is checked after the file.
wait_for() {
  local file=$1 left=$2
  while :; do
    if [ -e "$out/$file" ]; then
      no_failure
      return
    fi
    no_failure
    churn_alive
    if ! kill -0 "$app" 2>/dev/null; then
      echo "the app quit before writing $file" >&2
      tail -20 "$out/app.log" >&2
      exit 1
    fi
    left=$((left - 1))
    if [ "$left" -le 0 ]; then
      echo "no $file within $2 s" >&2
      exit 1
    fi
    sleep 1
  done
}

echo "app running; the window must stay on screen until it hides itself" >&2
wait_for steady.json 180
sleep "$SETTLE"
for n in $(seq 1 "$MEMORY_SAMPLES"); do
  [ "$n" -eq 1 ] || sleep "$MEMORY_EVERY"
  no_failure
  "$tool" sample "$app" >"$out/memory-$n.json"
done
wait_for idle.json 180
sleep "$IDLE_SETTLE"
"$tool" sample "$app" >"$out/idle-start.json"
sleep "$IDLE_SAMPLE"
"$tool" sample "$app" >"$out/idle-end.json"
if ! wait "$app"; then
  echo "the app failed after its last sample" >&2
  tail -40 "$out/app.log" >&2 2>/dev/null || true
  exit 1
fi
app=
no_failure
churn_alive
kill -INT "$churn"
if ! wait "$churn"; then
  echo "the churn generator failed" >&2
  tail -20 "$out/churn.log" >&2
  exit 1
fi
churn=

"$tool" report "$out"
echo "$out" >&2
