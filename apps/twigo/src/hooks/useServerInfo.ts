import { serverInfo } from "@/lib/api";
import { useAsyncDetail } from "./useAsyncDetail";

// Server details for a connection, with a refresh trigger. Keeps the data
// lifecycle out of the panel so the panel is pure presentation.
export function useServerInfo(connId: string) {
  return useAsyncDetail(() => serverInfo(connId), [connId]);
}
