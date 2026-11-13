#!/usr/bin/env bash
# Usage: bench/cluster.sh up|down <name> [kubernetes minor, default 1.37]
#
# A kind cluster with kwok and its fake nodes, $TWIGO_BENCH_NODES of them
# (default 10), and metrics-server, which reads the nodes' simulated usage
# from kwok: a pod's own comes from its annotations kwok.x-k8s.io/usage-cpu
# and usage-memory (bench/pods.sh sets them). The kubeconfig lives in
# $TWIGO_BENCH_DIR/<name>/kubeconfig, never in ~/.kube/config, and every
# kubectl call passes it explicitly.
set -euo pipefail

KWOK_VERSION=v0.8.0
KWOK_USAGE_SHA256=880e46f117cc83587a210aaacc9c6b49ff55aaf455648f497281634377d09437
METRICS_SERVER_VERSION=v0.9.1
METRICS_SERVER_SHA256=3c7f57cdbee0f57fb0259a150e8f6d6cb4f29d72d1aa5dce8803151dd6d4c2a1
NODES=${TWIGO_BENCH_NODES:-10}

usage() {
  echo "usage: $0 up|down <name> [1.33-1.37]" >&2
  exit 2
}

node_image() {
  case "$1" in
    1.33) echo "kindest/node:v1.33.12@sha256:3f5c8443c620245e4d355cfe09e96a91ead32ceaa569d3f1ca9edf0cb2fe2ff4" ;;
    1.34) echo "kindest/node:v1.34.11@sha256:44e222ee2132dab25ff87301682f89eb82c7880ea3a1bf543bfe9708fd08d67d" ;;
    1.35) echo "kindest/node:v1.35.8@sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0" ;;
    1.36) echo "kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed" ;;
    1.37) echo "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5" ;;
    *) echo "no kind node image for Kubernetes $1" >&2; exit 2 ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# Downloads <url> to <file>, which must have the checksum <sha256>.
fetch() {
  curl -fsSL "$1" -o "$3"
  [ "$(sha256 "$3")" = "$2" ] || { echo "$1 is not the release this script pins" >&2; exit 1; }
}

[ $# -ge 2 ] || usage
action=$1
name=$2
version=${3:-1.37}
[[ "$name" =~ ^[a-z0-9-]+$ ]] || { echo "invalid cluster name: $name" >&2; exit 2; }
dir="${TWIGO_BENCH_DIR:?set TWIGO_BENCH_DIR to a temporary directory}/$name"
kubeconfig="$dir/kubeconfig"
cluster="twigo-$name"
k() { kubectl --kubeconfig "$kubeconfig" "$@"; }

case "$action" in
  up)
    image=$(node_image "$version")
    mkdir -p "$dir"
    cat > "$dir/kind.yaml" <<YAML
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        apiVersion: kubeadm.k8s.io/v1beta3
        kind: ClusterConfiguration
        controllerManager:
          extraArgs: { kube-api-qps: "500", kube-api-burst: "1000" }
        scheduler:
          extraArgs: { kube-api-qps: "500", kube-api-burst: "1000" }
      - |
        apiVersion: kubeadm.k8s.io/v1beta4
        kind: ClusterConfiguration
        controllerManager:
          extraArgs:
            - { name: kube-api-qps, value: "500" }
            - { name: kube-api-burst, value: "1000" }
        scheduler:
          extraArgs:
            - { name: kube-api-qps, value: "500" }
            - { name: kube-api-burst, value: "1000" }
YAML
    kind create cluster --name "$cluster" --image "$image" \
      --config "$dir/kind.yaml" --kubeconfig "$kubeconfig" --wait 180s
    k apply -f "https://github.com/kubernetes-sigs/kwok/releases/download/$KWOK_VERSION/kwok.yaml"
    k apply -f "https://github.com/kubernetes-sigs/kwok/releases/download/$KWOK_VERSION/stage-fast.yaml"
    k -n kube-system rollout status deployment/kwok-controller --timeout=180s
    for i in $(seq 0 $((NODES - 1))); do
      cat <<YAML
---
apiVersion: v1
kind: Node
metadata:
  name: kwok-node-$i
  annotations:
    kwok.x-k8s.io/node: fake
    node.alpha.kubernetes.io/ttl: "0"
    metrics.k8s.io/resource-metrics-path: /metrics/nodes/kwok-node-$i/metrics/resource
  labels:
    kubernetes.io/hostname: kwok-node-$i
    kubernetes.io/os: linux
    type: kwok
spec:
  taints:
    - key: kwok.x-k8s.io/node
      value: fake
      effect: NoSchedule
status:
  allocatable: { cpu: "64", memory: 512Gi, pods: "1000" }
  capacity: { cpu: "64", memory: 512Gi, pods: "1000" }
YAML
    done | k apply -f - >/dev/null
    k wait --for=condition=Ready node -l type=kwok --timeout=120s >/dev/null
    fetch "https://github.com/kubernetes-sigs/kwok/releases/download/$KWOK_VERSION/metrics-usage.yaml" \
      "$KWOK_USAGE_SHA256" "$dir/metrics-usage.yaml"
    k apply -f "$dir/metrics-usage.yaml" >/dev/null
    fetch "https://github.com/kubernetes-sigs/metrics-server/releases/download/$METRICS_SERVER_VERSION/components.yaml" \
      "$METRICS_SERVER_SHA256" "$dir/metrics-server.yaml"
    k apply -f "$dir/metrics-server.yaml" >/dev/null
    k -n kube-system patch deployment metrics-server --type=json >/dev/null \
      -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
    k -n kube-system rollout status deployment/metrics-server --timeout=180s >/dev/null
    k wait --for=condition=Available apiservice/v1beta1.metrics.k8s.io --timeout=180s >/dev/null
    # What `kubectl top node` prints needs two scrapes of every node.
    served=0
    for _ in $(seq 1 90); do
      served=$(k get --raw /apis/metrics.k8s.io/v1beta1/nodes 2>/dev/null |
        grep -o '"name":"kwok-node-' | wc -l | tr -d ' ' || true)
      [ "$served" -ge "$NODES" ] && break
      sleep 2
    done
    [ "$served" -ge "$NODES" ] || { echo "metrics-server serves the usage of $served of $NODES kwok nodes" >&2; exit 1; }
    echo "$kubeconfig"
    ;;
  down)
    kind delete cluster --name "$cluster" --kubeconfig "$kubeconfig"
    rm -rf "$dir"
    ;;
  *)
    usage
    ;;
esac
