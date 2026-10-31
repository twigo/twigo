#!/usr/bin/env bash
# Usage: bench/test-matrix.sh [1.32 1.33 ...]
#
# Runs the live Table tests on a fresh kind cluster per Kubernetes version,
# 1.32 to 1.37 by default, and deletes each cluster afterwards.
set -euo pipefail

cd "$(dirname "$0")/.."
versions=("$@")
[ ${#versions[@]} -gt 0 ] || versions=(1.32 1.33 1.34 1.35 1.36 1.37)

for version in "${versions[@]}"; do
  name="matrix-${version/./}"
  kubeconfig=$(bench/cluster.sh up "$name" "$version" | tail -1)
  status=0
  TWIGO_TEST_KUBECONFIG="$kubeconfig" cargo test -p twigo-cache --test table_live -- --ignored || status=$?
  bench/cluster.sh down "$name"
  echo "Kubernetes $version: $([ $status -eq 0 ] && echo passed || echo FAILED)"
  [ $status -eq 0 ] || exit $status
done
