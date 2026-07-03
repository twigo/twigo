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
  resolve: (connId: string, subject: string) => Mapping | null;
  schemaById: (id: string | undefined) => Schema | undefined;
}

export const useCodecs = create<CodecsState>()(
  persist(
    (set, get) => ({
      schemas: [],
      mappings: {},

      addSchema: (s) =>
        set((state) => ({
          schemas: [...state.schemas, { ...s, id: crypto.randomUUID() }],
        })),

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
        set((state) => ({
          mappings: {
            ...state.mappings,
            [connId]: [
              ...(state.mappings[connId] ?? []),
              { ...m, id: crypto.randomUUID() },
            ],
          },
        })),

      removeMapping: (connId, id) =>
        set((state) => ({
          mappings: {
            ...state.mappings,
            [connId]: (state.mappings[connId] ?? []).filter((m) => m.id !== id),
          },
        })),

      resolve: (connId, subject) => {
        const ms = (get().mappings[connId] ?? []).filter((m) =>
          subjectMatches(m.pattern, subject),
        );
        if (ms.length === 0) return null;
        return ms.reduce((best, m) =>
          m.pattern.replace(/[*>]/g, "").length >
          best.pattern.replace(/[*>]/g, "").length
            ? m
            : best,
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
