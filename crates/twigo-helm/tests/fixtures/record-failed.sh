#!/usr/bin/env bash
# Usage: crates/twigo-helm/tests/fixtures/record-failed.sh <helm> <kubeconfig> <context>
#
# Records `epsilon`, a release whose upgrade failed while its first revision
# stays deployed, into secrets/ and get/ beside this script, on a kind cluster
# of `bench/cluster.sh up <name> 1.37`. Revision 1 is installed with
# client-side apply; revision 2 puts a value that is no base64 into its
# Secret's data, which the API server refuses with the patched object quoted
# in Helm's description of the revision. Every helm and kubectl call names
# the cluster, and helm keeps its files in a temporary directory.
set -euo pipefail

[ $# -eq 3 ] || { echo "usage: $0 <helm> <kubeconfig> <context>" >&2; exit 2; }
helm_bin=$1
kubeconfig=$2
context=$3
case "$context" in
  kind-*) ;;
  *) echo "refusing $context: only kind-* contexts" >&2; exit 2 ;;
esac
here=$(cd "$(dirname "$0")" && pwd)
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
export HELM_CONFIG_HOME=$home/config HELM_CACHE_HOME=$home/cache HELM_DATA_HOME=$home/data TZ=UTC

h() { "$helm_bin" --kubeconfig "$kubeconfig" --kube-context "$context" "$@"; }
k() { kubectl --kubeconfig "$kubeconfig" --context "$context" "$@"; }

h version
k create namespace fmt-a
h install epsilon "$here/charts/failing" -n fmt-a --server-side=false --set password=epsilon-password-r1
if h upgrade epsilon "$here/charts/failing" -n fmt-a --set password=epsilon-password-r2 --set 'extra=not base64!'; then
  echo "the upgrade was meant to fail" >&2
  exit 1
fi

for revision in 1 2; do
  name=sh.helm.release.v1.epsilon.v$revision
  k get secret "$name" -n fmt-a -o json >"$here/secrets/fmt-a.$name.json"
  h get manifest epsilon -n fmt-a --revision "$revision" >"$here/get/epsilon.r$revision.v4.manifest.txt"
  h get notes epsilon -n fmt-a --revision "$revision" >"$here/get/epsilon.r$revision.v4.notes.txt"
done
h history epsilon -n fmt-a -o json >"$here/get/epsilon.v4.history.json"
k get secrets -n fmt-a -l owner=helm,name=epsilon --show-labels
