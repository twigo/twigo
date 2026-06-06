// TODO(#5): replace with the real Subject Explorer data.
export interface SubjectNode {
  token: string;
  rate: number;
  children?: SubjectNode[];
}

export const mockSubjects: SubjectNode[] = [
  {
    token: "orders",
    rate: 14,
    children: [
      { token: "created", rate: 12 },
      { token: "failed", rate: 2 },
    ],
  },
  {
    token: "payments",
    rate: 6,
    children: [
      { token: "authorized", rate: 4 },
      { token: "captured", rate: 2 },
    ],
  },
  { token: "telemetry", rate: 120 },
];
