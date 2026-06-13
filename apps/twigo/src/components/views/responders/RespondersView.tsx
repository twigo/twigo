import type { ReactNode } from "react";
import { Play, Plus, Square, Trash2 } from "lucide-react";
import { cn } from "@twigo/ui";
import { useConnections } from "@/store/connections";
import { useResponder } from "@/store/responder";
import { openResponder, openResponderTab } from "@/lib/editor";
import type { ViewProps } from "@/shell/views";

const ROW_BTN =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function IconButton({
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
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

export function RespondersView({ filter, connId }: ViewProps) {
  const conns = useResponder((s) => (connId ? s.byConn[connId] : undefined));
  const live = useConnections(
    (s) => !!(connId && s.connected[connId]?.connected),
  );
  const list = Object.values(conns ?? {})
    .filter((s) =>
      s.config.subject.toLowerCase().includes(filter.toLowerCase()),
    )
    .sort((a, b) => a.config.subject.localeCompare(b.config.subject));
  const hasNone = Object.keys(conns ?? {}).length === 0;

  if (!connId) {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        Connect to a server to manage responders.
      </p>
    );
  }

  return (
    <>
      <ul className="space-y-0.5">
        <li className="flex items-center rounded-md px-1 hover:bg-accent">
          <button
            type="button"
            onClick={() => openResponder(connId)}
            className={cn(
              "flex w-full items-center gap-2 py-1.5 text-left",
              ROW_BTN,
            )}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <Plus className="size-3.5 text-muted-foreground" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">
                New responder
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                Mock a subject with a reply
              </span>
            </span>
          </button>
        </li>

        {list.map((s) => {
          return (
            <li
              key={s.id}
              className="group flex items-center gap-1 rounded-md px-1 hover:bg-accent"
            >
              <button
                type="button"
                onClick={() =>
                  openResponderTab(s.id, s.connId, s.config.subject)
                }
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left",
                  ROW_BTN,
                )}
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      s.listening
                        ? "animate-pulse bg-ok"
                        : "bg-muted-foreground/40",
                    )}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">
                    {s.config.subject || "(no subject)"}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {s.config.mode} · {s.handled} handled
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                {s.listening ? (
                  <IconButton
                    label="Stop responder"
                    onClick={() =>
                      void useResponder.getState().stop(s.connId, s.id)
                    }
                  >
                    <Square />
                  </IconButton>
                ) : (
                  <IconButton
                    label="Start responder"
                    disabled={!live || s.config.subject.trim() === ""}
                    onClick={() =>
                      void useResponder.getState().start(s.connId, s.id)
                    }
                  >
                    <Play />
                  </IconButton>
                )}
                <IconButton
                  label="Delete responder"
                  onClick={() => useResponder.getState().remove(s.connId, s.id)}
                >
                  <Trash2 />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ul>

      {hasNone ? (
        <p className="px-2 pt-2 text-[11px] leading-relaxed text-muted-foreground">
          No responders for <span className="font-mono">{connId}</span> yet. Use
          the button above, or right-click a subject → “Mock this subject…”.
        </p>
      ) : list.length === 0 ? (
        <p className="px-2 pt-2 text-[11px] text-muted-foreground">
          No responders match “{filter.trim()}”.
        </p>
      ) : null}
    </>
  );
}
