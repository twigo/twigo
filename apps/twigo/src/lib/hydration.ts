import { useEffect, useState } from "react";
import { useUi } from "@/store/ui";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useResponder } from "@/store/responder";
import { useReadOnly } from "@/store/readonly";
import { useMonitorConfig } from "@/store/monitorConfig";

interface Hydratable {
  persist: {
    hasHydrated: () => boolean;
    onFinishHydration: (cb: () => void) => () => void;
  };
}

// useReadOnly gates writes, so it must load before the first interaction (else a
// locked connection looks writable for a microtask at launch); useMonitorConfig
// likewise so a saved monitoring URL isn't briefly treated as missing.
const STORES: Hydratable[] = [
  useUi,
  useSettings,
  useWorkspace,
  useResponder,
  useReadOnly,
  useMonitorConfig,
];

/**
 * True once every persisted store has loaded from disk. With the async Tauri
 * store this gates the first render so the layout/theme aren't built from
 * defaults and then snapped to the restored values.
 */
export function useAppHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() =>
    STORES.every((s) => s.persist.hasHydrated()),
  );

  useEffect(() => {
    if (hydrated) return;
    const check = () => {
      if (STORES.every((s) => s.persist.hasHydrated())) setHydrated(true);
    };
    const unsubs = STORES.map((s) => s.persist.onFinishHydration(check));
    // Close the render→subscribe gap (a store may finish between the initial
    // snapshot and these subscriptions). Deferred to avoid a sync set in effect.
    queueMicrotask(check);
    // Watchdog: a stuck/corrupt store must never permanently brick the gate.
    const watchdog = setTimeout(() => {
      setHydrated(true);
    }, 3000);
    return () => {
      for (const unsub of unsubs) unsub();
      clearTimeout(watchdog);
    };
  }, [hydrated]);

  return hydrated;
}
