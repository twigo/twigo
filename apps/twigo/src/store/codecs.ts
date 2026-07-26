import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";
import type { CodecId } from "@/lib/api";

export interface Schema {
  id: string;
  name: string;
  descriptorSetB64: string;
  messageTypes: string[];
}

export interface Mapping {
  id: string;
  pattern: string;
  codec: CodecId;
  schemaId?: string;
  messageType?: string;
}

export function validPattern(pattern: string): boolean {
  const tokens = pattern.split(".");
  return (
    tokens.length > 0 &&
    tokens.every((t, i) => t !== "" && (t !== ">" || i === tokens.length - 1))
  );
}

export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return s.length >= i + 1;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

interface CodecsState {
  schemas: Schema[];
  mappings: Record<string, Mapping[]>;
  addSchema: (s: Omit<Schema, "id">) => void;
  removeSchema: (id: string) => void;
  addMapping: (connId: string, m: Omit<Mapping, "id">) => void;
  removeMapping: (connId: string, id: string) => void;
  clearConn: (connId: string) => void;
  resolve: (connId: string, subject: string) => Mapping | null;
  schemaById: (id: string | undefined) => Schema | undefined;
}

export const useCodecs = create<CodecsState>()(
  persist(
    (set, get) => ({
      schemas: [],
      mappings: {},

      // Re-importing an updated .proto keeps the schema's identity, so existing
      // mappings decode with the new descriptor instead of the stale one.
      addSchema: (s) =>
        set((state) => {
          const existing = state.schemas.find((x) => x.name === s.name);
          return {
            schemas: existing
              ? state.schemas.map((x) =>
                  x.id === existing.id ? { ...s, id: existing.id } : x,
                )
              : [...state.schemas, { ...s, id: crypto.randomUUID() }],
          };
        }),

      removeSchema: (id) =>
        set((state) => ({
          schemas: state.schemas.filter((s) => s.id !== id),
          mappings: Object.fromEntries(
            Object.entries(state.mappings).map(([conn, ms]) => [
              conn,
              ms.filter((m) => m.schemaId !== id),
            ]),
          ),
        })),

      addMapping: (connId, m) =>
        set((state) => {
          const ms = state.mappings[connId] ?? [];
          const existing = ms.find((x) => x.pattern === m.pattern);
          return {
            mappings: {
              ...state.mappings,
              [connId]: existing
                ? ms.map((x) =>
                    x.id === existing.id ? { ...m, id: existing.id } : x,
                  )
                : [...ms, { ...m, id: crypto.randomUUID() }],
            },
          };
        }),

      removeMapping: (connId, id) =>
        set((state) => ({
          mappings: {
            ...state.mappings,
            [connId]: (state.mappings[connId] ?? []).filter((m) => m.id !== id),
          },
        })),

      // Mappings are keyed by context name, so a deleted context must drop them -
      // otherwise a later context reusing the name inherits another server's codecs.
      clearConn: (connId) =>
        set((state) => {
          if (!(connId in state.mappings)) return state;
          const { [connId]: _dropped, ...rest } = state.mappings;
          return { mappings: rest };
        }),

      resolve: (connId, subject) => {
        const ms = (get().mappings[connId] ?? []).filter((m) =>
          subjectMatches(m.pattern, subject),
        );
        if (ms.length === 0) return null;
        // Specificity, most decisive first: literal tokens, then a bounded
        // pattern over a `>` tail, then length. Insertion order never decides.
        const score = (p: string): number[] => {
          const tokens = p.split(".");
          return [
            tokens.filter((t) => t !== "*" && t !== ">").length,
            tokens.includes(">") ? 0 : 1,
            tokens.length,
          ];
        };
        const narrower = (a: number[], b: number[]) => {
          for (let i = 0; i < a.length; i++) {
            const x = a[i] ?? 0;
            const y = b[i] ?? 0;
            if (x !== y) return x > y;
          }
          return false;
        };
        return ms.reduce((best, m) =>
          narrower(score(m.pattern), score(best.pattern)) ? m : best,
        );
      },

      schemaById: (id) => get().schemas.find((s) => s.id === id),
    }),
    {
      name: "twigo-codecs",
      version: 1,
      storage: createPersistStorage(),
      partialize: (s) => ({ schemas: s.schemas, mappings: s.mappings }),
    },
  ),
);
