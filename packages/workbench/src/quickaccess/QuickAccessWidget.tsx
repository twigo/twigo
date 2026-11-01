import { useEffect, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Kbd,
} from "@twigo/ui";
import { toIpcError } from "@twigo/protocol";
import { PanelBoundary } from "../parts/PanelBoundary";
import { useChanges, useWorkbench } from "../react";
import { filtered } from "./providers";
import type { QuickPickItem, Session } from "./registry";

/** The quick-access input at the top of the window (ARCHITECTURE 4.5). */
export function QuickAccessWidget() {
  const workbench = useWorkbench();
  const { quickAccess } = workbench;
  useChanges(quickAccess.changes);
  const { session } = quickAccess;
  if (!session) return null;
  return (
    <PanelBoundary
      label="Quick access"
      fallback={() => null}
      onCrash={(error) => {
        quickAccess.hide();
        workbench.report(error, "Quick access crashed");
      }}
    >
      <Open session={session} />
    </PanelBoundary>
  );
}

type Loaded =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly items: readonly QuickPickItem[] }
  | { readonly state: "failed"; readonly message: string };

function Open({ session }: { session: Session }) {
  const workbench = useWorkbench();
  const { quickAccess } = workbench;
  const { value, pick, context } = session;
  const resolved = pick ? undefined : quickAccess.resolve(value);
  const [loaded, setLoaded] = useState<{ value: string; result: Loaded }>();

  useEffect(() => {
    if (pick) return;
    let live = true;
    const target = quickAccess.resolve(value);
    if (!target) return;
    Promise.resolve(target.provider.items(target.filter, context)).then(
      (items) => {
        if (live) setLoaded({ value, result: { state: "ready", items } });
      },
      (error: unknown) => {
        if (live) {
          setLoaded({
            value,
            result: { state: "failed", message: toIpcError(error).message },
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [quickAccess, value, pick, context]);

  const result: Loaded = pick
    ? { state: "ready", items: filtered(pick.items, value) }
    : loaded?.value === value
      ? loaded.result
      : { state: "loading" };
  const items = result.state === "ready" ? result.items : [];
  const groups = [...new Set(items.map((item) => item.group))];

  return (
    <div
      className="fixed inset-0 z-40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) quickAccess.hide();
      }}
    >
      <Command
        shouldFilter={false}
        loop
        label="Quick access"
        className="absolute top-12 left-1/2 h-auto w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 border border-border shadow-lg"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            quickAccess.hide();
          }
        }}
      >
        <CommandInput
          autoFocus
          value={value}
          onValueChange={(next) => {
            quickAccess.setValue(next);
          }}
          placeholder={pick?.placeholder ?? resolved?.provider.placeholder}
        />
        <CommandList>
          {result.state === "failed" ? (
            <p className="px-2 py-3 text-xs text-error">{result.message}</p>
          ) : (
            result.state === "ready" && <CommandEmpty>No results</CommandEmpty>
          )}
          {groups.map((group) => (
            <CommandGroup key={group ?? ""} heading={group}>
              {items
                .filter((item) => item.group === group)
                .map((item) => (
                  <Item key={item.id} item={item} />
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </div>
  );
}

function Item({ item }: { item: QuickPickItem }) {
  const workbench = useWorkbench();
  const Icon = item.icon;
  return (
    <CommandItem
      value={item.id}
      onSelect={() => {
        workbench.quickAccess.accept(item).catch((error: unknown) => {
          workbench.report(error);
        });
      }}
    >
      {Icon && <Icon className="size-3.5 text-muted-foreground" />}
      <span className="truncate">{item.label}</span>
      {item.description && (
        <span className="truncate text-muted-foreground">
          {item.description}
        </span>
      )}
      {item.keybinding && <Kbd className="ml-auto">{item.keybinding}</Kbd>}
    </CommandItem>
  );
}
