import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  HighlightedLabel,
  Kbd,
  StatusLabel,
  Tile,
} from "@twigo/ui";
import { toIpcError } from "@twigo/protocol";
import { PanelBoundary } from "../parts/PanelBoundary";
import { initials } from "../parts/spaceBadge";
import { useChanges, useWorkbench } from "../react";
import { QUICK_INPUT } from "./commands";
import { filtered } from "./providers";
import type {
  AcceptOptions,
  QuickAccessProvider,
  QuickPickItem,
  Session,
} from "./registry";

/**
 * Quick access (ARCHITECTURE 4.5), dropped from the title bar's search
 * field and centred under the title bar, as VS Code's Command Center.
 */
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

/** cmdk's own keys, which go to the keybinding service instead. */
const BOUND_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter"]);

function Open({ session }: { session: Session }) {
  const workbench = useWorkbench();
  const { quickAccess, keybindings, keys } = workbench;
  const { value, pick, context } = session;
  const provider = pick ? undefined : quickAccess.resolve(value)?.provider;
  const [loaded, setLoaded] = useState<{ value: string; result: Loaded }>();
  const [selected, setSelected] = useState("");
  const root = useRef<HTMLDivElement>(null);

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
  const ordered = groups.flatMap((group) =>
    items.filter((item) => item.group === group),
  );
  const at = Math.max(
    0,
    ordered.findIndex((item) => item.id === selected),
  );
  const active = ordered[at];

  const toSide = provider?.toSide === true;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const scope = keys.scope(element);
    scope.set("inQuickOpen", true);
    scope.set("quickOpenToSide", toSide);
    return () => {
      scope.dispose();
    };
  }, [keys, toSide]);

  const accept = (item: QuickPickItem, options: AcceptOptions) => {
    quickAccess.accept(item, options).catch((error: unknown) => {
      workbench.report(error);
    });
  };

  useEffect(
    () =>
      quickAccess.attach({
        move: (delta) => {
          if (ordered.length === 0) return;
          const next = (at + delta + ordered.length) % ordered.length;
          setSelected(ordered[next]?.id ?? "");
        },
        accept: (options) => {
          if (active) accept(active, options);
        },
      }),
    // `ordered` and `active` come anew with every render, as does `accept`.
  );

  useEffect(() => {
    root.current
      ?.querySelectorAll("[cmdk-item]")
      [at]?.scrollIntoView({ block: "nearest" });
  }, [at]);

  return (
    <div
      className="fixed inset-0 z-40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) quickAccess.hide();
      }}
    >
      <Command
        ref={root}
        shouldFilter={false}
        value={active?.id ?? ""}
        onValueChange={setSelected}
        label="Quick access"
        className="absolute top-10 left-1/2 h-auto w-[min(600px,62vw)] -translate-x-1/2"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            quickAccess.hide();
            return;
          }
          // The keybinding service goes first, so ↑, ↓ and Enter are
          // bindings the user may change, and cmdk leaves them alone.
          if (
            keybindings.dispatch(event.nativeEvent) ||
            BOUND_KEYS.has(event.key)
          ) {
            event.preventDefault();
          }
        }}
      >
        <CommandInput
          autoFocus
          value={value}
          onValueChange={(next) => {
            quickAccess.setValue(next);
          }}
          placeholder={pick?.placeholder ?? provider?.placeholder}
        />
        <CommandList>
          {result.state === "failed" ? (
            <p className="px-3 py-3 text-xs text-error">{result.message}</p>
          ) : (
            result.state === "ready" && <CommandEmpty>No results</CommandEmpty>
          )}
          {groups.map((group) => (
            <CommandGroup key={group ?? ""} heading={group}>
              {items
                .filter((item) => item.group === group)
                .map((item) => (
                  <Row
                    key={item.id}
                    item={item}
                    onAccept={() => {
                      accept(item, { side: false });
                    }}
                  />
                ))}
            </CommandGroup>
          ))}
        </CommandList>
        <Footer provider={provider} picking={pick !== undefined} />
      </Command>
    </div>
  );
}

function Row({
  item,
  onAccept,
}: {
  item: QuickPickItem;
  onAccept: () => void;
}) {
  const Icon = item.icon;
  return (
    <CommandItem
      value={item.id}
      onSelect={onAccept}
      className={item.tile ? "h-9" : undefined}
    >
      {item.tile ? (
        <Tile
          letters={initials(item.tile.name)}
          color={item.tile.color}
          size="sm"
        />
      ) : (
        Icon && <Icon aria-hidden className="size-3.5 text-muted-foreground" />
      )}
      <HighlightedLabel
        text={item.label}
        ranges={item.matches ?? []}
        className="min-w-0"
      />
      {item.description && (
        <span className="min-w-0 shrink-[3] truncate text-xs text-muted-foreground">
          {item.description}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2 text-xs text-muted-foreground">
        {item.state && (
          <StatusLabel
            tone={item.state.tone}
            pulse={item.state.pulse}
            className="max-w-56"
          >
            {item.state.label}
          </StatusLabel>
        )}
        {item.kind && (
          <span className="w-20 truncate text-right text-muted-foreground-2">
            {item.kind}
          </span>
        )}
        {item.keybinding && <Kbd>{item.keybinding}</Kbd>}
      </span>
    </CommandItem>
  );
}

/**
 * The keys of what quick access does, as the keybinding registry binds
 * them, and on the empty prefix the prefixes the providers name.
 */
function Footer({
  provider,
  picking,
}: {
  provider: QuickAccessProvider | undefined;
  picking: boolean;
}) {
  const { keybindings, quickAccess } = useWorkbench();
  useChanges(keybindings.changes);
  const keysOf = (command: string) => {
    const binding = keybindings.primary(command);
    return binding ? [keybindings.label(binding.presses)] : [];
  };
  const move = [...keysOf(QUICK_INPUT.previous), ...keysOf(QUICK_INPUT.next)];
  const accept = keysOf(QUICK_INPUT.accept);
  const side = provider?.toSide ? keysOf(QUICK_INPUT.acceptToSide) : [];
  const prefixes =
    provider?.prefix === ""
      ? quickAccess
          .providers()
          .filter((other) => other.prefix !== "" && other.hint)
      : [];
  return (
    <div
      aria-label="Keys"
      className="flex h-[30px] shrink-0 items-center gap-3.5 border-t border-border px-3 text-[11px] whitespace-nowrap text-muted-foreground"
    >
      {move.length > 0 && <Hint keys={move}>Move</Hint>}
      {accept.length > 0 && (
        <Hint keys={accept}>
          {picking ? "Select" : (provider?.acceptLabel ?? "Open")}
        </Hint>
      )}
      {side.length > 0 && <Hint keys={side}>Open to the side</Hint>}
      <span className="flex-1" />
      {prefixes.map((other) => (
        <Hint key={other.prefix} keys={[other.prefix.trim()]}>
          {other.hint}
        </Hint>
      ))}
    </div>
  );
}

function Hint({
  keys,
  children,
}: {
  keys: readonly string[];
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1">
      <span className="flex gap-0.5">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
      {children}
    </span>
  );
}
