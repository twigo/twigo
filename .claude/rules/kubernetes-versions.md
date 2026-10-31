---
paths:
  - "bench/**"
  - ".github/workflows/kubernetes.yml"
  - "crates/*/tests/**"
---

# Kubernetes versions

- Twigo supports Kubernetes 1.33 and later ([D12](../../docs/ARCHITECTURE.md)).
  Never add 1.32 or older to `bench/`, the CI matrix or a test.
- A new release joins `bench/cluster.sh`, `bench/test-matrix.sh` and the CI
  matrix once kind publishes its node image, pinned by digest.
