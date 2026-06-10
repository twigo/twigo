import type { ReactNode } from "react";
import { Unplug, Server, RotateCw, Plus } from "lucide-react";
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

export function ConnectionPicker({ onClose }: { onClose: () => void }) {
  const contexts = useConnections((s) => s.contexts);
  const connected = useConnections((s) => s.connected);
  const connecting = useConnections((s) => s.connecting);
  const connError = useConnections((s) => s.connError);
  const activeContext = useConnections((s) => s.activeContext);
  const setActive = useConnections((s) => s.setActive);
  const connect = useConnections((s) => s.connect);
  const disconnect = useConnections((s) => s.disconnect);
  const load = useConnections((s) => s.load);

  const live = contexts.filter((c) => connected[c.name]);
  const available = contexts.filter((c) => !connected[c.name]);

  function pick(c: ContextSummary) {
    if (connected[c.name]) {
      setActive(c.name);
      onClose();
    } else {
      void connect(c.name);
    }
  }

  function row(c: ContextSummary) {
    const info = connected[c.name];
    const err = connError[c.name];
    const isActive = activeContext === c.name;
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
        ) : !info ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {c.url.replace(/^\w+:\/\//, "")}
          </span>
        ) : null}
        {info && (
          <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-data-[selected=true]:opacity-100">
            <ActionButton
              label="Server info"
              disabled={!info.connected}
              onClick={() => {
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
          className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        >
          <Plus />
          Add connection…
        </button>
      </div>
    </Command>
  );
}
