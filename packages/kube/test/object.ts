import type { Field, Header, Measure, Section } from "@twigo/protocol";
import { PageStates } from "../src/object/pageStates";

export const NO_HEADER: Header = {
  owner: null,
  node: null,
  created: null,
  generated: null,
  printed: [],
  sentence: [],
  vitals: [],
};

export const PAGE = {
  pages: new PageStates(),
  uri: "k8s://test",
  object: "a",
  onEvents: () => undefined,
};

export const measure = (rest: Partial<Measure>): Measure => ({
  used: null,
  request: null,
  limit: null,
  allocatable: null,
  ...rest,
});

export const field = (
  label: string,
  text: string,
  byDefault = false,
): Field => ({
  label,
  value: { type: "text", text },
  default: byDefault,
});

export const ROLLOUT_STUCK: Section = {
  id: "core.diagnostics",
  title: "Diagnostics",
  summary: [],
  tone: "danger",
  fold: "open",
  blocks: [
    {
      type: "diagnostics",
      findings: [
        {
          logs: null,
          tone: "danger",
          title: "The rollout is stuck",
          detail: [],
          message: "ReplicaSet has timed out progressing.",
        },
      ],
    },
  ],
};
