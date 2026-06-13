import { useReadOnly } from "@/store/readonly";

// True when the given connection is locked read-only - used to disable write
// controls (the api.ts guard is the backstop; this is the proactive UX).
export function useIsReadOnly(connId: string | null | undefined): boolean {
  return useReadOnly((s) => (connId ? (s.byConn[connId] ?? false) : false));
}
