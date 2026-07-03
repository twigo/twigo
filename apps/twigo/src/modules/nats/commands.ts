import {
  registerCommand,
  registerCommandProvider,
  type Command,
} from "@/lib/commands";
import { useConnections } from "@/store/connections";
import { useReadOnly } from "@/store/readonly";
import { useJetStream } from "@/store/jetstream";
import { useKv } from "@/store/kv";
import { useObjStore } from "@/store/objstore";
import { newPublish, newResponder } from "@/lib/actions";
import { useServices } from "@/store/services";
import {
  openStreamDetail,
  openConsumerDetail,
  openService,
} from "@/lib/editor";
import { useUi } from "@/store/ui";

const hasLive = () =>
  Object.values(useConnections.getState().connected).some((i) => i.connected);

// JetStream-backed features (streams, KV, object store) need a live connection
// whose server has JetStream enabled.
const jsEnabled = () => {
  const { activeContext, connected } = useConnections.getState();
  return !!(activeContext && connected[activeContext]?.jetstream);
};

const activeConn = () => useConnections.getState().activeContext;

// One connect/switch command per known context (dynamic - contexts change).
function connectionCommands(): Command[] {
  const { contexts, connected } = useConnections.getState();
  return contexts.map((c): Command => {
    const isConnected = !!connected[c.name];
    return {
      id: `conn.${c.name}`,
      title: isConnected ? `Switch to ${c.name}` : `Connect to ${c.name}`,
      category: "Connections",
      keywords: c.name,
      run: isConnected
        ? () => useConnections.getState().setActive(c.name)
        : () => {
            // Connect to and switch to it, matching the connection switcher.
            useConnections.getState().setActive(c.name);
            void useConnections.getState().connect(c.name);
          },
    };
  });
}

// Loaded entities as jumpable palette entries (DataGrip's search-everywhere).
function entityCommands(): Command[] {
  const conn = activeConn();
  if (!conn) return [];
  const out: Command[] = [];
  const js = useJetStream.getState().byConn[conn];
  for (const s of js?.parents ?? []) {
    out.push({
      id: `jump.stream.${s.name}`,
      title: `Stream: ${s.name}`,
      category: "Jump",
      keywords: "jetstream stream",
      run: () => {
        openStreamDetail(conn, s.name);
      },
    });
    for (const c of js?.children[s.name] ?? []) {
      out.push({
        id: `jump.consumer.${s.name}.${c.name}`,
        title: `Consumer: ${s.name} › ${c.name}`,
        category: "Jump",
        keywords: "jetstream consumer",
        run: () => {
          openConsumerDetail(conn, s.name, c.name);
        },
      });
    }
  }
  for (const b of useKv.getState().byConn[conn]?.parents ?? []) {
    out.push({
      id: `jump.kv.${b.bucket}`,
      title: `KV bucket: ${b.bucket}`,
      category: "Jump",
      keywords: "kv key value bucket",
      run: () => {
        useUi.setState({ activeView: "kv", sidebarOpen: true });
      },
    });
  }
  for (const b of useObjStore.getState().byConn[conn]?.parents ?? []) {
    out.push({
      id: `jump.obj.${b.bucket}`,
      title: `Object bucket: ${b.bucket}`,
      category: "Jump",
      keywords: "object store bucket",
      run: () => {
        useUi.setState({ activeView: "objectstore", sidebarOpen: true });
      },
    });
  }
  for (const svc of useServices.getState().byConn[conn]?.services ?? []) {
    out.push({
      id: `jump.service.${svc.name}.${svc.id}`,
      title: `Service: ${svc.name} · ${svc.id}`,
      category: "Jump",
      keywords: "micro service",
      run: () => {
        openService(conn, svc.name, svc.id);
      },
    });
  }
  return out;
}

export function registerNatsCommands(): void {
  registerCommand(
    {
      id: "publish.new",
      title: "New publish",
      category: "Create",
      keywords: "request reply",
      keybinding: "mod+n",
      when: hasLive,
      run: newPublish,
    },
    {
      id: "responder.new",
      title: "New responder (mock)",
      category: "Create",
      keywords: "mock service template",
      when: hasLive,
      run: newResponder,
    },
    {
      id: "connections.reload",
      title: "Reload nats contexts",
      category: "Connections",
      run: () => void useConnections.getState().load(),
    },
    {
      id: "connections.toggle-readonly",
      title: "Toggle read-only for active connection",
      category: "Connections",
      keywords: "lock protect guard write",
      when: () => !!activeConn(),
      run: () => {
        const active = activeConn();
        if (active) useReadOnly.getState().toggle(active);
      },
    },
    {
      id: "jetstream.refresh",
      title: "JetStream: Refresh streams",
      category: "Connections",
      keywords: "jetstream stream consumer",
      when: jsEnabled,
      run: () => {
        const active = activeConn();
        if (active) void useJetStream.getState().load(active);
      },
    },
    {
      id: "kv.refresh",
      title: "KV: Refresh buckets",
      category: "Connections",
      keywords: "kv key value bucket",
      when: jsEnabled,
      run: () => {
        const active = activeConn();
        if (active) void useKv.getState().load(active);
      },
    },
    {
      id: "objstore.refresh",
      title: "Object Store: Refresh",
      category: "Connections",
      keywords: "object store bucket file",
      when: jsEnabled,
      run: () => {
        const active = activeConn();
        if (active) void useObjStore.getState().load(active);
      },
    },
  );
  registerCommandProvider(connectionCommands);
  registerCommandProvider(entityCommands);
}
