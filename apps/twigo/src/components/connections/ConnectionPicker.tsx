import type { ReactNode } from "react";
import {
  Unplug,
  Server,
  RotateCw,
  Plus,
  Pencil,
  Lock,
  LockOpen,
} from "lucide-react";
import {
  cn,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@twigo/ui";
import { useConnections } from "@/store/connections";
import { useReadOnly } from "@/store/readonly";
import { openServerInfo } from "@/lib/editor";
import type { ContextSummary } from "@/lib/api";
import { StatusGlyph } from "./StatusGlyph";

const SEARCH_THRESHOLD = 7;

function ActionButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

export function ConnectionPicker({
  onClose,
  onAdd,
  onEdit,
}: {
  onClose: () => void;
  onAdd: () => void;
  onEdit: (name: string) => void;
}) {
  const contexts = useConnections((s) => s.contexts);
  const connected = useConnections((s) => s.connected);
  const connecting = useConnections((s) => s.connecting);
  const connError = useConnections((s) => s.connError);
  const activeContext = useConnections((s) => s.activeContext);
  const setActive = useConnections((s) => s.setActive);
  const connect = useConnections((s) => s.connect);
  const disconnect = useConnections((s) => s.disconnect);
  const load = useConnections((s) => s.load);
  const readOnlyMap = useReadOnly((s) => s.byConn);
  const toggleReadOnly = useReadOnly((s) => s.toggle);

  const live = contexts.filter((c) => connected[c.name]);
  const available = contexts.filter((c) => !connected[c.name]);

  function pick(c: ContextSummary) {
    if (connected[c.name]) {
      setActive(c.name);
      onClose();
    } else {
      setActive(c.name);
      void connect(c.name);
    }
  }

  function row(c: ContextSummary) {
    const info = connected[c.name];
    const err = connError[c.name];
    const isActive = activeContext === c.name;
    const readOnly = !!readOnlyMap[c.name];
    return (
      <CommandItem
        key={c.name}
        value={c.name}
        onSelect={() => pick(c)}
        aria-current={isActive}
        className={cn("group relative", isActive && "bg-accent/50")}
      >
        {isActive && (
          <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
        )}
        <StatusGlyph
          info={info}
          connecting={!!connecting[c.name]}
          error={!!err}
        />
        <span
          className={cn("min-w-0 flex-1 truncate", isActive && "font-medium")}
        >
          {c.name}
        </span>
        {connecting[c.name] ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            connecting…
          </span>
        ) : err && !info ? (
          <span className="min-w-0 truncate text-[11px] text-error">{err}</span>
        ) : (
          // The target host, but capped so it never crowds out the name (two
          // contexts on the same server stay distinguishable; the title reveals
          // the actually-reached server).
          <span
            className="min-w-0 max-w-[40%] truncate font-mono text-[11px] text-muted-foreground"
            title={info ? `${c.url} · server: ${info.serverName}` : c.url}
          >
            {c.url.replace(/^\w+:\/\//, "")}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-0.5">
          {/* The lock is its own indicator: lit and always shown when read-only,
              revealed on hover (to lock) otherwise. */}
          <button
            type="button"
            aria-label={
              readOnly
                ? `Allow writes on ${c.name}`
                : `Make ${c.name} read-only`
            }
            title={
              readOnly ? "Read-only - click to allow writes" : "Make read-only"
            }
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleReadOnly(c.name);
            }}
            className={cn(
              "flex size-5 items-center justify-center rounded hover:bg-background [&_svg]:size-3.5",
              readOnly
                ? "text-warn"
                : "text-muted-foreground opacity-0 hover:text-foreground group-data-[selected=true]:opacity-100",
            )}
          >
            {readOnly ? <Lock /> : <LockOpen />}
          </button>
          {/* The demo context is synthetic (no file on disk), so it can't be edited. */}
          {c.name !== "demo.nats.io" && (
            <button
              type="button"
              aria-label={`Edit ${c.name}`}
              title="Edit connection"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onEdit(c.name);
              }}
              className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-data-[selected=true]:opacity-100 [&_svg]:size-3.5"
            >
              <Pencil />
            </button>
          )}
          {info && (
            <span className="flex items-center gap-0.5 opacity-0 group-data-[selected=true]:opacity-100">
              <ActionButton
                label="Server info"
                disabled={!info.connected}
                onClick={() => {
                  setActive(c.name);
                  openServerInfo(c.name);
                  onClose();
                }}
              >
                <Server />
              </ActionButton>
              <ActionButton
                label={`Disconnect ${c.name}`}
                onClick={() => void disconnect(c.name)}
              >
                <Unplug />
              </ActionButton>
            </span>
          )}
        </span>
      </CommandItem>
    );
  }

  return (
    <Command>
      {contexts.length > SEARCH_THRESHOLD && (
        <CommandInput placeholder="Search connections…" />
      )}
      <CommandList>
        <CommandEmpty>No connections found.</CommandEmpty>
        {live.length > 0 && (
          <CommandGroup heading="Live">{live.map(row)}</CommandGroup>
        )}
        {live.length > 0 && available.length > 0 && <CommandSeparator />}
        {available.length > 0 && (
          <CommandGroup heading="Available">{available.map(row)}</CommandGroup>
        )}
      </CommandList>
      <div className="flex items-center justify-between border-t border-border p-1">
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        >
          <RotateCw />
          Reload
        </button>
        <button
          type="button"
          onClick={onAdd}
          title="Create a new nats context"
          className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        >
          <Plus />
          Add connection…
        </button>
      </div>
    </Command>
  );
}
