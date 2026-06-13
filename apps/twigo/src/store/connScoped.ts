// Registry of per-connection stores that must drop a connection's state when it
// disconnects, drops, or closes. Domain stores self-register here so the
// connections store doesn't import every domain by hand - a new domain (or a
// future non-NATS module) joins teardown without editing connections.ts.

interface Resettable {
  getState: () => { reset: (connId: string) => void };
}

const registry = new Set<Resettable>();

export function registerConnScoped(store: Resettable): void {
  registry.add(store);
}

export function resetConnScopedStores(connId: string): void {
  for (const store of registry) store.getState().reset(connId);
}

// Test-only: drop registrations so a suite starts from a clean registry.
export function clearConnScopedRegistry(): void {
  registry.clear();
}
