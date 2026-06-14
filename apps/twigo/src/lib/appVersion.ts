import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// The bundle version, read at runtime so it always matches the actual build
// (stamped from the release tag in CI). Falls back to "dev" in the browser.
export function useAppVersion(): string {
  const [version, setVersion] = useState(inTauri ? "" : "dev");
  useEffect(() => {
    if (!inTauri) return;
    let active = true;
    void getVersion().then((v) => {
      if (active) setVersion(v);
    });
    return () => {
      active = false;
    };
  }, []);
  return version;
}
