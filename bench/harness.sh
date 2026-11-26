#!/usr/bin/env bash
# Usage: bench/harness.sh [kubeconfig]
#
# ARCHITECTURE 3.8's six metrics at 5k pods, on macOS. Builds the app's bench mode in release,
# runs the churn generator at 100 changes/s against a kwok cluster, launches the app with
# TWIGO_BENCH and the cluster's kubeconfig as TWIGO_KUBECONFIG, samples its memory with the pod
# list open and its CPU with the window on screen and hidden; then, with a shell in a pod, a
# port-forward and a terminal open, which the app opens through its own commands, samples the
# core's CPU while the terminal watches the pods through the policy proxy and straight to the
# cluster, and the sessions again once that watch is stopped. It prints the report. Without a
# kubeconfig it creates the cluster (bench/cluster.sh up bench, bench/pods.sh 5000) and deletes
# it at the end; a given one must hold the 5,000 pods already. The terminal runs the kubectl of
# PATH. report.json and the files it is built from land in $TWIGO_BENCH_DIR/harness.
set -euo pipefail

PODS=5000
RATE=100
SETTLE=10
MEMORY_SAMPLES=5
MEMORY_EVERY=2
VISIBLE_SETTLE=5
VISIBLE_SAMPLE=20
IDLE_SETTLE=5
IDLE_SAMPLE=30
# As many as the driver's WATCHES (apps/desktop/bench/sessions.ts).
WINDOWS=4
SESSIONS_NAMESPACE=bench-sessions
FORWARD_PORT=8080

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
kubectl_path=$(command -v kubectl) || { echo "the terminal runs kubectl from PATH, and there is none" >&2; exit 2; }
command -v curl >/dev/null || { echo "the harness reads the forward with curl, and there is none" >&2; exit 2; }

created=
app=
churn=
sessions_kubeconfig=
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
  if [ -n "$sessions_kubeconfig" ] && [ -z "$created" ]; then
    kubectl --kubeconfig "$sessions_kubeconfig" delete namespace "$SESSIONS_NAMESPACE" \
      --ignore-not-found --timeout=90s >&2 || true
  fi
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

kubeconfig=$(cd "$(dirname "$kubeconfig")" && pwd)/$(basename "$kubeconfig")
k() { kubectl --kubeconfig "$kubeconfig" "$@"; }

# The pod the app opens a shell in runs on kind's node, from the image the node holds, so that
# nothing is pulled: it has bash and no other command, so it sleeps by reading a coprocess that
# never writes (crates/twigo-sessions/tests/logs_live.rs). The forward reaches CoreDNS's health
# port, which answers over HTTP.
node=$(k get nodes -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[0].metadata.name}')
image=$(k get node "$node" -o jsonpath='{.status.images[*].names[*]}' |
  tr ' ' '\n' | grep -m1 '^docker.io/kindest/local-path-helper:')
[ -n "$image" ] || { echo "$node holds no docker.io/kindest/local-path-helper image" >&2; exit 1; }
forward_pod=$(k -n kube-system get pods -l k8s-app=kube-dns -o jsonpath='{.items[0].metadata.name}')
sessions_kubeconfig=$kubeconfig
# A pod that does not start fails the sessions only, so it is kept for them (`shell_failed`) and the
# budgets are measured all the same.
shell_pod() {
  # A run that was killed, or whose clean-up timed out, leaves the namespace behind.
  k delete namespace "$SESSIONS_NAMESPACE" --ignore-not-found --timeout=120s >&2 || return 1
  k create namespace "$SESSIONS_NAMESPACE" >&2 || return 1
  for _ in $(seq 1 60); do
    k -n "$SESSIONS_NAMESPACE" get serviceaccount default >/dev/null 2>&1 && break
    sleep 1
  done
  k -n "$SESSIONS_NAMESPACE" apply -f - >&2 <<YAML || return 1
apiVersion: v1
kind: Pod
metadata:
  name: shell
spec:
  nodeName: $node
  terminationGracePeriodSeconds: 0
  containers:
    - name: shell
      image: $image
      imagePullPolicy: Never
      command:
        - sh
        - -c
        - 'coproc S { read; }; while :; do read -t 3600 -u "\${S[0]}"; done'
YAML
  k -n "$SESSIONS_NAMESPACE" wait --for=condition=Ready pod/shell --timeout=120s >&2
}
shell_failed=
shell_pod || shell_failed="the pod shell in $SESSIONS_NAMESPACE was not made ready (kubectl's error is on the harness's stderr)"
sessions=$(jq -cn --arg namespace "$SESSIONS_NAMESPACE" --arg forward "$forward_pod" \
  --argjson port "$FORWARD_PORT" --arg kubectl "$kubectl_path" --arg kubeconfig "$kubeconfig" \
  '{shell: {namespace: $namespace, pod: "shell", container: "shell"},
    forward: {namespace: "kube-system", pod: $forward, port: $port},
    kubectl: $kubectl, kubeconfig: $kubeconfig}')

echo "building in release" >&2
cargo build --manifest-path "$root/Cargo.toml" --release -p twigo-bench >&2
cargo run --manifest-path "$root/Cargo.toml" --release -p twigo-policy --example gate_cost \
  >"$out/gate-cost.json" 2>"$out/gate-cost.log" || { cat "$out/gate-cost.log" >&2; exit 1; }
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
client=$("$kubectl_path" version --client -o json | jq -r .clientVersion.gitVersion)
jq -n --arg date "$date" --arg machine "$cpu, $memory GB" --arg os "macOS $os_version" \
  --arg commit "$commit" --arg build release --arg kubectl "$client" \
  '{date: $date, machine: $machine, os: $os, commit: $commit, build: $build, kubectl: $kubectl}' \
  >"$out/run.json"

"$tool" churn --kubeconfig "$kubeconfig" --rate "$RATE" --log "$out/churn.jsonl" \
  >"$out/churn.json" 2>"$out/churn.log" &
churn=$!

churn_alive() {
  if ! kill -0 "$churn" 2>/dev/null; then
    tail -20 "$out/churn.log" >&2
    fail "the churn generator exited"
  fi
}

# The driver writes failure.json when a phase the report judges failed, which stops the run whenever
# it comes, and sessions-failure.json when a step of the sessions did. Past the idle sample the judged
# rows are measured, so a failure of the sessions' part is kept in sessions-failure.json and reported
# with them, where before it stopped the run (`tolerate`).
tolerate=

fail() {
  echo "$1" >&2
  if [ -n "$tolerate" ]; then
    [ -e "$out/sessions-failure.json" ] ||
      jq -n --arg message "$1" '{message: $message}' >"$out/sessions-failure.json"
    return 1
  fi
  exit 1
}

no_failure() {
  if [ -e "$out/failure.json" ]; then
    cat "$out/failure.json" >&2
    echo >&2
    exit 1
  fi
  if [ -e "$out/sessions-failure.json" ]; then
    cat "$out/sessions-failure.json" >&2
    echo >&2
    if [ -n "$tolerate" ]; then return 1; fi
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
# The terminal's login shell reads no startup file of the person's, which an empty ZDOTDIR gives it,
# so that what it prints and runs is the same on every Mac.
mkdir -p "$out/zdotdir"
TWIGO_BENCH=$out TWIGO_BENCH_SESSIONS=$sessions TWIGO_KUBECONFIG=$kubeconfig ZDOTDIR=$out/zdotdir \
  "$tool" launch "$target/release/twigo" >"$out/app.log" 2>&1 &
app=$!

# The webview writes failure.json and then idle.json, so a failure is checked after the file.
wait_for() {
  local file=$1 left=$2
  while :; do
    if [ -e "$out/$file" ]; then
      no_failure || return 1
      return 0
    fi
    no_failure || return 1
    churn_alive || return 1
    if ! kill -0 "$app" 2>/dev/null; then
      tail -20 "$out/app.log" >&2
      fail "the app quit before writing $file" || return 1
    fi
    left=$((left - 1))
    if [ "$left" -le 0 ]; then
      fail "no $file within $2 s" || return 1
    fi
    sleep 1
  done
}

take() {
  "$tool" sample "$app" >"$out/$1" || fail "the app could not be sampled for $1, it has quit"
}

echo "app running, its window at the screen's left edge; keep the screen unlocked" >&2
# What the API server has counted, for the gate's share of the core's CPU over the steady phase.
snapshot() {
  "$tool" sample "$app" >"$out/steady-$1.json"
  k get --raw /metrics >"$out/apiserver-$1.txt"
}
wait_for steady.json 180
snapshot start
sleep "$SETTLE"
for n in $(seq 1 "$MEMORY_SAMPLES"); do
  [ "$n" -eq 1 ] || sleep "$MEMORY_EVERY"
  no_failure
  "$tool" sample "$app" >"$out/memory-$n.json"
done
wait_for visible.json 120
snapshot end
sleep "$VISIBLE_SETTLE"
"$tool" sample "$app" >"$out/visible-start.json"
sleep "$VISIBLE_SAMPLE"
"$tool" sample "$app" >"$out/visible-end.json"
if [ -e "$out/idle.json" ]; then
  echo "the window hid before the visible sample ended" >&2
  exit 1
fi
wait_for idle.json 180
sleep "$IDLE_SETTLE"
"$tool" sample "$app" >"$out/idle-start.json"
sleep "$IDLE_SAMPLE"
"$tool" sample "$app" >"$out/idle-end.json"
# A page that never turned hidden is reported 90 s after the hide, and that stops the run.
wait_for hidden.json 120

# The sessions: the driver opens a shell, a port-forward and a terminal, and the harness samples them.
sessions_phase() {
  local port status n
  [ -z "$shell_failed" ] || { fail "$shell_failed" || return 1; }
  echo "the window is back; the app opens a shell, a port-forward and a terminal" >&2
  wait_for sessions.json 180 || return 1
  port=$(jq -r .forward.local "$out/sessions.json") || return 1
  status=$(curl -sS --max-time 10 -o "$out/forward-read.body" -w '%{http_code}' \
    "http://127.0.0.1:$port/health") || {
    fail "the forward on localhost:$port does not answer" || return 1
  }
  [ "$status" = 200 ] || { fail "the forward answers HTTP $status, not 200" || return 1; }
  jq -n --argjson status "$status" --argjson bytes "$(wc -c <"$out/forward-read.body")" \
    '{status: $status, bytes: $bytes}' >"$out/forward-read.json" || return 1
  for n in $(seq 1 "$WINDOWS"); do
    wait_for "watch-$n.json" 120 || return 1
    sleep "$VISIBLE_SETTLE"
    take "window-$n-start.json" || return 1
    sleep "$VISIBLE_SAMPLE"
    take "window-$n-end.json" || return 1
    if [ -e "$out/watched-$n.json" ]; then
      fail "watch window $n ended before its sample did" || return 1
    fi
  done
  # The sessions' rows are sampled once the driver has stopped the watch and the shell is back at
  # its prompt: nothing runs in them.
  wait_for stopped.json 60 || return 1
  sleep "$SETTLE"
  for n in $(seq 1 "$MEMORY_SAMPLES"); do
    [ "$n" -eq 1 ] || sleep "$MEMORY_EVERY"
    no_failure || return 1
    take "sessions-memory-$n.json" || return 1
  done
  sleep "$VISIBLE_SETTLE"
  take sessions-visible-start.json || return 1
  sleep "$VISIBLE_SAMPLE"
  take sessions-visible-end.json || return 1
  if [ -e "$out/idle-sessions.json" ]; then
    fail "the window hid before the sessions' visible sample ended" || return 1
  fi
  wait_for idle-sessions.json 180 || return 1
  sleep "$IDLE_SETTLE"
  take idle-sessions-start.json || return 1
  sleep "$IDLE_SAMPLE"
  take idle-sessions-end.json || return 1
}

tolerate=1
sessions_phase || true
tolerate=
if [ -e "$out/sessions-failure.json" ]; then
  kill "$app" 2>/dev/null || true
  wait "$app" 2>/dev/null || true
elif ! wait "$app"; then
  echo "the app failed after its last sample" >&2
  tail -40 "$out/app.log" >&2 2>/dev/null || true
  exit 1
fi
app=
failed=
kill -INT "$churn" 2>/dev/null || true
if ! wait "$churn"; then
  echo "the churn generator failed" >&2
  tail -20 "$out/churn.log" >&2
  # It printed no summary, which the report would read from the empty file.
  rm -f "$out/churn.json"
  failed=1
fi
churn=

"$tool" report "$out" || failed=1
echo "$out" >&2
[ -z "$failed" ] || exit 1
