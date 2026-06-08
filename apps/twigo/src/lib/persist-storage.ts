import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { Store } from "@tauri-apps/plugin-store";

// Persist through tauri-plugin-store (origin-independent, survives the prod
// scheme change) when running inside Tauri; fall back to localStorage in the
// browser/tests.
const FILE = "twigo.workspace.json";

const hasTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let storePromise: Promise<Store> | null = null;
function tauriStore(): Promise<Store> {
  storePromise ??= import("@tauri-apps/plugin-store").then((m) =>
    m.load(FILE, { autoSave: 200, defaults: {} }),
  );
  return storePromise;
}

async function getRaw(name: string): Promise<string | null> {
  try {
    if (!hasTauri) return localStorage.getItem(name);
    const store = await tauriStore();
    return (await store.get<string>(name)) ?? null;
  } catch {
    return null;
  }
}

async function setRaw(name: string, value: string): Promise<void> {
  try {
    if (!hasTauri) {
      localStorage.setItem(name, value);
      return;
    }
    const store = await tauriStore();
    await store.set(name, value);
  } catch {
    /* best effort: a failed write must not surface to the UI */
  }
}

async function delRaw(name: string): Promise<void> {
  try {
    if (!hasTauri) {
      localStorage.removeItem(name);
      return;
    }
    const store = await tauriStore();
    await store.delete(name);
  } catch {
    /* best effort */
  }
}

// Custom PersistStorage that parses defensively: a corrupt/foreign value
// resolves to null (→ store defaults) instead of throwing into zustand's
// hydrate(), which would otherwise never finish and hang the hydration gate.
export function createPersistStorage<S>(): PersistStorage<S> {
  return {
    getItem: async (name) => {
      const raw = await getRaw(name);
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as StorageValue<S>;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => setRaw(name, JSON.stringify(value)),
    removeItem: (name) => delRaw(name),
  };
}
