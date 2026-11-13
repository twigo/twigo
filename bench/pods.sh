#!/usr/bin/env bash
# Usage: bench/pods.sh <kubeconfig> <count>
#
# Scales the Deployment bench/bench to <count> pods on the kwok nodes, waits
# until all of them are available, and gives each the usage kwok simulates
# for it (kwok.x-k8s.io/usage-cpu and usage-memory, which metrics-server of
# bench/cluster.sh reports), stepping with the pod's place in the list, so
# that sorting by either has pods to tell apart.
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: $0 <kubeconfig> <count>" >&2; exit 2; }
kubeconfig=$1
count=$2
k() { kubectl --kubeconfig "$kubeconfig" "$@"; }

k apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: bench
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bench
  namespace: bench
spec:
  replicas: $count
  selector:
    matchLabels: { app: bench }
  template:
    metadata:
      labels: { app: bench }
    spec:
      nodeSelector: { type: kwok }
      tolerations:
        - key: kwok.x-k8s.io/node
          operator: Exists
          effect: NoSchedule
      containers:
        - name: app
          image: fake-image
YAML
k -n bench wait --for=jsonpath='{.status.availableReplicas}'="$count" deployment/bench --timeout=900s >/dev/null
k -n bench get pods -o name |
  awk '{ printf "%s kwok.x-k8s.io/usage-cpu=%dm kwok.x-k8s.io/usage-memory=%dMi\n", $1, (NR % 97 + 1) * 10, (NR * 7) % 211 + 16 }' |
  xargs -L 1 -P 16 kubectl --kubeconfig "$kubeconfig" -n bench annotate --overwrite >/dev/null
k -n bench get deployment bench -o jsonpath='{.status.availableReplicas}{" pods available\n"}'
