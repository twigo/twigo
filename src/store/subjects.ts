import { create } from "zustand";
import { startSubjectWatch, stopSubjectWatch } from "@/lib/api";
import type { SubjectStat } from "@/lib/subject-tree";

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

  update: (conn, stats, truncated) =>
    set((s) => ({ byConn: { ...s.byConn, [conn]: { stats, truncated } } })),

  startWatch: async (conn, pattern) => {
    const effective = pattern.trim() || ">";
    await startSubjectWatch(conn, effective);
    set((s) => ({ watching: { ...s.watching, [conn]: effective } }));
  },

  stopWatch: async (conn) => {
    await stopSubjectWatch(conn);
    set((s) => {
      const { [conn]: _w, ...watching } = s.watching;
      const { [conn]: _b, ...byConn } = s.byConn;
      return { watching, byConn };
    });
  },

  reset: (conn) =>
    set((s) => {
      const { [conn]: _w, ...watching } = s.watching;
      const { [conn]: _b, ...byConn } = s.byConn;
      return { watching, byConn };
    }),
}));
