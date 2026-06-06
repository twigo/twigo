/**
 * Temporary mock data so the layout has something to render.
 * Replaced by real nats context import (#3) + connection manager (#4).
 */
export interface MockConnection {
  id: string;
  name: string;
  url: string;
  status: "connected" | "disconnected";
}

export const mockConnections: MockConnection[] = [
  { id: "local", name: "local", url: "nats://127.0.0.1:4222", status: "connected" },
  { id: "staging", name: "staging", url: "nats://staging:4222", status: "disconnected" },
  { id: "prod", name: "prod", url: "tls://prod:4222", status: "disconnected" },
];

export interface SubjectNode {
  token: string;
  rate: number; // msg/s
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
