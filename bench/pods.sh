#!/usr/bin/env bash
# Usage: bench/pods.sh <kubeconfig> <count>
#
# Scales the Deployment bench/bench to <count> pods on the kwok nodes and
# waits until all of them are available.
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
k -n bench get deployment bench -o jsonpath='{.status.availableReplicas}{" pods available\n"}'
