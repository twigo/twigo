import { create } from "zustand";
import { startSubjectWatch, stopSubjectWatch } from "@/lib/api";
import { useWorkspace } from "@/store/workspace";
import { registerConnScoped } from "@/store/connScoped";
import type { SubjectStat } from "@twigo/utils";

interface ConnSubjects {
  stats: SubjectStat[];
  truncated: boolean;
}

interface SubjectsState {
  byConn: Record<string, ConnSubjects>;
  watching: Record<string, string>;
  update: (conn: string, stats: SubjectStat[], truncated: boolean) => void;
  startWatch: (conn: string, pattern: string) => Promise<void>;
  stopWatch: (conn: string) => Promise<void>;
  reset: (conn: string) => void;
}

export const useSubjects = create<SubjectsState>((set) => ({
  byConn: {},
  watching: {},

  // Live watch stats arrive as events, so a late one can land after reset() /
  // stopWatch() removed the watch; only apply it while a watch is still active,
  // else it would resurrect a ghost entry for a dead connection.
  update: (conn, stats, truncated) =>
    set((s) =>
      s.watching[conn]
        ? { byConn: { ...s.byConn, [conn]: { stats, truncated } } }
        : s,
    ),

  startWatch: async (conn, pattern) => {
    const effective = pattern.trim() || ">";
    await startSubjectWatch(conn, effective);
    set((s) => ({ watching: { ...s.watching, [conn]: effective } }));
    useWorkspace.getState().setWatching(conn, effective);
  },

  stopWatch: async (conn) => {
    await stopSubjectWatch(conn);
    set((s) => {
      const { [conn]: _w, ...watching } = s.watching;
      const { [conn]: _b, ...byConn } = s.byConn;
      return { watching, byConn };
    });
    useWorkspace.getState().setWatching(conn, null);
  },

  // Live teardown only (on disconnect/drop). The persisted watch intent is
  // kept so a reconnect/restore can resume it; an explicit disconnect clears it.
  reset: (conn) => {
    set((s) => {
      const { [conn]: _w, ...watching } = s.watching;
      const { [conn]: _b, ...byConn } = s.byConn;
      return { watching, byConn };
    });
  },
}));

registerConnScoped(useSubjects);
