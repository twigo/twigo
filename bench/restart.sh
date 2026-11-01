#!/usr/bin/env bash
# Usage: bench/restart.sh <kubeconfig of a kind cluster> [app, default target/debug/twigo]
#
# What the app keeps across ⌘Q and a restart, on macOS (ARCHITECTURE 4.8).
# The app runs in the explicit-kubeconfig mode with a HOME of its own, whose
# ~/.kube/config holds a context that mode refuses. The script
# 1. starts the app, which opens the space of the cluster's context;
# 2. hides the side bar with ⌘B, quits with ⌘Q 100 ms later, and checks the
#    state file;
# 3. starts it again, shows the side bar with ⌘B, quits, and checks again:
#    only a side bar restored as hidden turns visible;
# 4. checks that the refused context never reached the state.
# The keys go through System Events, which needs the terminal's
# Accessibility permission. They go only while the app is in front, checked
# before each key, since macOS may refuse to bring it forward while you
# type elsewhere, and ⌘Q would then quit that other app; key codes keep
# them independent of the keyboard layout.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <kubeconfig> [app]" >&2; exit 2; }
kubeconfig=$1
app=${2:-target/debug/twigo}
if ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers xml1 -o - - |
  grep -A1 CGSSessionScreenIsLocked | grep -q true; then
  echo "the screen is locked: the app's window does not show, and System Events sees none" >&2
  exit 1
fi
context=$(kubectl --kubeconfig "$kubeconfig" config current-context)
case "$context" in
  kind-*) ;;
  *) echo "$context is not a kind context" >&2; exit 2 ;;
esac

home=$(mktemp -d)
pid=
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$home"' EXIT
mkdir -p "$home/.kube"
cat >"$home/.kube/config" <<YAML
clusters:
- name: refused
  cluster: { server: 'https://127.0.0.1:1' }
contexts:
- name: prod-refused
  context: { cluster: refused }
YAML
state="$home/Library/Application Support/io.twigo.ide/state.json"

# Prints the side bar's visibility in the context's space, or "none".
sidebar() {
  python3 - "$state" "$context" <<'PY'
import json, sys
path, context = sys.argv[1:]
try:
    spaces = json.load(open(path))["spaces"]
except FileNotFoundError:
    spaces = []
space = next((s for s in spaces if s["id"] == context), None)
parts = space and space["state"].get("parts")
print("none" if not parts else str(parts["sidebar"]["visible"]).lower())
PY
}

start() {
  HOME="$home" TWIGO_KUBECONFIG="$kubeconfig" "$app" >>"$home/app.log" 2>&1 &
  pid=$!
  for _ in $(seq 100); do
    windows=$(osascript -e "tell application \"System Events\" to count windows of (first process whose unix id is $pid)" 2>/dev/null || echo 0)
    [ "$windows" -gt 0 ] && break
    sleep 0.1
  done
  [ "$windows" -gt 0 ] || { echo "the app opened no window" >&2; exit 1; }
  # The webview loads the workbench and opens the space after the window shows.
  sleep 3
}

# ⌘B, then ⌘Q within the 300 ms the webview once waited before saving.
toggle_and_quit() {
  if ! osascript >/dev/null <<OSA; then
tell application "System Events"
  set twigo to first process whose unix id is $pid
  set frontmost of twigo to true
  repeat 50 times
    if frontmost of twigo then exit repeat
    delay 0.1
  end repeat
  if not (frontmost of twigo) then error "the app is not in front"
  key code 11 using command down
  delay 0.1
  if not (frontmost of twigo) then error "the app is not in front"
  key code 12 using command down
end tell
OSA
    echo "the app did not come to the front, so no key was sent; leave the screen alone and run again" >&2
    exit 1
  fi
  (sleep 10 && kill "$pid" 2>/dev/null) &
  watchdog=$!
  status=0
  wait "$pid" || status=$?
  kill "$watchdog" 2>/dev/null || true
  pid=
  if [ "$status" -ne 0 ]; then
    echo "the app did not quit cleanly on ⌘Q (status $status)" >&2
    exit 1
  fi
}

expect() {
  local got
  got=$(sidebar)
  if [ "$got" != "$1" ]; then
    echo "FAIL: $2: the side bar is $got, not $1" >&2
    cat "$home/app.log" >&2
    exit 1
  fi
  echo "ok: $2"
}

start
toggle_and_quit
expect false "hidden by ⌘B, then ⌘Q"
start
toggle_and_quit
expect true "restored as hidden, then shown by ⌘B"
if grep -q prod-refused "$state"; then
  echo "FAIL: the refused context reached the state" >&2
  exit 1
fi
echo "ok: the refused context never reached the state"
