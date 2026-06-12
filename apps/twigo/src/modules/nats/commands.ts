import {
  registerCommand,
  registerCommandProvider,
  type Command,
} from "@/lib/commands";
import { useConnections } from "@/store/connections";
import { useJetStream } from "@/store/jetstream";
import { useKv } from "@/store/kv";
import { useObjStore } from "@/store/objstore";
import { newPublish, newResponder } from "@/lib/actions";

const hasLive = () =>
  Object.values(useConnections.getState().connected).some((i) => i.connected);

// JetStream-backed features (streams, KV, object store) need a live connection
// whose server has JetStream enabled.
const jsEnabled = () => {
  const { activeContext, connected } = useConnections.getState();
  return !!(activeContext && connected[activeContext]?.jetstream);
};

const activeConn = () => useConnections.getState().activeContext;

// One connect/switch command per known context (dynamic — contexts change).
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
}
