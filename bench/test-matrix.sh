#!/usr/bin/env bash
# Usage: bench/test-matrix.sh [1.33 1.34 ...]
#
# Runs the live tests on a fresh kind cluster per Kubernetes version,
# 1.33 to 1.37 by default, and deletes each cluster afterwards.
set -euo pipefail

cd "$(dirname "$0")/.."
versions=("$@")
[ ${#versions[@]} -gt 0 ] || versions=(1.33 1.34 1.35 1.36 1.37)

name=
cleanup() {
  [ -z "$name" ] || bench/cluster.sh down "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for version in "${versions[@]}"; do
  name="matrix-${version/./}"
  kubeconfig=$(bench/cluster.sh up "$name" "$version" | tail -1)
  status=0
  TWIGO_TEST_KUBECONFIG="$kubeconfig" cargo test -p twigo-cache -p twigo-kube -p twigo-core -p twigo-bench -p twigo-sessions -- --ignored || status=$?
  bench/cluster.sh down "$name"
  name=
  echo "Kubernetes $version: $([ $status -eq 0 ] && echo passed || echo FAILED)"
  [ $status -eq 0 ] || exit $status
done
