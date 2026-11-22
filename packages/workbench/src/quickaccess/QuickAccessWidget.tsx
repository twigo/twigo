import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  HighlightedLabel,
  Kbd,
  QuickInput,
  QuickInputEmpty,
  QuickInputField,
  QuickInputGroup,
  QuickInputList,
  QuickInputOption,
  StatusLabel,
  Tick,
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
  | {
      readonly state: "ready";
      readonly items: readonly QuickPickItem[];
      readonly notice?: string;
    }
  | { readonly state: "failed"; readonly message: string };

/** Keys that are the keybinding service's alone: unbound, they still move no caret and submit nothing. */
const BOUND_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter"]);

interface Checks {
  readonly prefix: string;
  /** Every row met so far, hidden by the filter or not, as ticked or not. */
  readonly ticks: ReadonlyMap<string, boolean>;
  /** Whether a row was ticked or unticked: from then Enter applies the ticked set and a click ticks. */
  readonly touched: boolean;
}

const noChecks = (prefix: string): Checks => ({
  prefix,
  ticks: new Map(),
  touched: false,
});

/** The ticks with those of the rows met first, which start as the rows say. */
function seeded(
  before: Checks,
  prefix: string,
  items: readonly QuickPickItem[],
): Checks {
  const base = before.prefix === prefix ? before : noChecks(prefix);
  const added = items.filter(
    (item) => item.checked !== undefined && !base.ticks.has(item.id),
  );
  if (added.length === 0) return base;
  const ticks = new Map(base.ticks);
  for (const item of added) ticks.set(item.id, item.checked === true);
  return { ...base, ticks };
}

const ticked = (checks: Checks): string[] =>
  [...checks.ticks].flatMap(([id, on]) => (on ? [id] : []));

function Open({ session }: { session: Session }) {
  const workbench = useWorkbench();
  const { quickAccess, keybindings, keys } = workbench;
  const { value, pick, ask, context } = session;
  const resolved = pick || ask ? undefined : quickAccess.resolve(value);
  const provider = resolved?.provider;
  const many = provider?.acceptChecked !== undefined;
  const [loaded, setLoaded] = useState<{ value: string; result: Loaded }>();
  const [cursor, setCursor] = useState({ value, id: "" });
  if (cursor.value !== value) setCursor({ value, id: "" });
  const [held, setChecks] = useState(noChecks(""));
  const checks = held.prefix === provider?.prefix ? held : noChecks("");
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const early = useRef<{ value: string; options: AcceptOptions }>(undefined);

  // The command a row accepted may pick in the tick the palette closed in, after
  // quick access gave the focus back and before this widget unmounted, so
  // autoFocus never fires for the pick.
  useEffect(() => {
    field.current?.focus();
  }, [pick, ask]);

  const source = pick?.source;
  useEffect(() => {
    if (ask || (pick && !source)) return;
    const target = source ? undefined : quickAccess.resolve(value);
    const load = source
      ? () => source(value)
      : target && (() => target.provider.items(target.filter, context));
    if (!load) return;
    let live = true;
    Promise.resolve(load()).then(
      (picked) => {
        // A load that another value has outdated still names the rows with a
        // tick, so a row the filter hides before it is shown keeps its own.
        if (target?.provider.acceptChecked) {
          const { prefix } = target.provider;
          const rows = "items" in picked ? picked.items : picked;
          setChecks((before) => seeded(before, prefix, rows));
        }
        if (live) {
          setLoaded({
            value,
            result:
              "items" in picked
                ? { state: "ready", ...picked }
                : { state: "ready", items: picked },
          });
        }
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
  }, [quickAccess, value, pick, source, ask, context]);

  const result: Loaded = ask
    ? { state: "ready", items: [] }
    : pick && !source
      ? { state: "ready", items: filtered(pick.items, value) }
      : loaded?.value === value
        ? loaded.result
        : { state: "loading" };
  const items = result.state === "ready" ? result.items : [];
  const groups = [...new Set(items.map((item) => item.group))].map((group) => ({
    group,
    items: items.filter((item) => item.group === group),
  }));
  const ordered = groups.flatMap(({ items: rows }) => rows);
  const ids = useId();
  const rowIds = new Map(
    ordered.map((item, index) => [item, `${ids}-${String(index)}`]),
  );
  const found = ordered.findIndex((item) => item.id === cursor.id);
  const unfiltered = (resolved?.filter.trim() ?? "") === "";
  const at = found >= 0 ? found : many && unfiltered ? -1 : 0;
  const active = ordered[at];
  const on = (item: QuickPickItem) =>
    item.checked === undefined
      ? undefined
      : (checks.ticks.get(item.id) ?? item.checked);
  const count = ticked(checks).length;

  const toSide = provider?.toSide === true;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const scope = keys.scope(element);
    scope.set("inQuickOpen", true);
    scope.set("quickOpenToSide", toSide);
    scope.set("quickOpenCanPickMany", many);
    return () => {
      scope.dispose();
    };
  }, [keys, toSide, many]);

  const accept = (item: QuickPickItem, options: AcceptOptions) => {
    if (item.disabled) return;
    quickAccess.accept(item, options).catch((error: unknown) => {
      workbench.report(error);
    });
  };

  const toggle = (item: QuickPickItem) => {
    const before = on(item);
    if (before === undefined) return;
    const next = new Map(checks.ticks).set(item.id, !before);
    setChecks({ prefix: provider?.prefix ?? "", ticks: next, touched: true });
    // The next name replaces what is filtered now, and not the prefix.
    const input = field.current;
    if (input) {
      input.focus();
      input.setSelectionRange(
        value.length - (resolved?.filter.length ?? 0),
        value.length,
      );
    }
  };

  const words = (n: number) => provider?.checkedWords?.(n) ?? String(n);

  const alone = many && !checks.touched && active?.checked !== undefined;
  const action = active !== undefined && active.checked === undefined;
  const loading = result.state === "loading";
  // Nothing left to take: no row under the cursor and no tick made.
  // The rows of a filter typed may put one under the cursor once they load, those of an empty filter never do.
  const closes =
    many &&
    (!loading || unfiltered) &&
    !action &&
    !checks.touched &&
    active === undefined;

  const applyChecked = () => {
    quickAccess.acceptChecked(ticked(checks)).catch((error: unknown) => {
      workbench.report(error);
    });
  };

  const apply = (options: AcceptOptions) => {
    if (ask) quickAccess.submit();
    else if (loading) early.current = { value, options };
    else if (closes) quickAccess.hide();
    else if (checks.touched && !action) applyChecked();
    else if (active) accept(active, options);
  };

  // An Enter before the rows of its value have come acts on them once they do.
  useEffect(() => {
    const waiting = early.current;
    early.current = undefined;
    if (waiting?.value === value) apply(waiting.options);
  });

  useEffect(
    () =>
      quickAccess.attach({
        move: (delta) => {
          if (ordered.length === 0) return;
          const next =
            at < 0
              ? delta > 0
                ? 0
                : ordered.length - 1
              : (at + delta + ordered.length) % ordered.length;
          setCursor({ value, id: ordered[next]?.id ?? "" });
        },
        accept: apply,
        toggle: () => {
          if (active) toggle(active);
        },
      }),
    // `ordered` and `active` come anew with every render, as do the handlers.
  );

  useEffect(() => {
    root.current
      ?.querySelectorAll("[role=option]")
      [at]?.scrollIntoView({ block: "nearest" });
  }, [at]);

  return (
    <div
      className="fixed inset-0 z-40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) quickAccess.hide();
      }}
    >
      <QuickInput
        ref={root}
        className="absolute top-10 left-1/2 h-auto w-[min(600px,62vw)] -translate-x-1/2"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            quickAccess.hide();
            return;
          }
          // The keybinding service goes first, so ↑, ↓ and Enter are
          // bindings the user may change.
          if (
            keybindings.dispatch(event.nativeEvent) ||
            BOUND_KEYS.has(event.key)
          ) {
            event.preventDefault();
          }
        }}
      >
        <QuickInputField
          ref={field}
          controls={`${ids}-list`}
          active={active && rowIds.get(active)}
          aria-label="Quick access"
          // An input starts with all its value selected, as VS Code's.
          {...(ask && {
            onFocus: (event) => {
              event.currentTarget.select();
            },
          })}
          value={value}
          onChange={(event) => {
            quickAccess.setValue(event.target.value);
          }}
          placeholder={
            ask?.placeholder ?? pick?.placeholder ?? provider?.placeholder
          }
        />
        <QuickInputList id={`${ids}-list`} multiselectable={many}>
          {many && (
            <p role="status" className="sr-only">
              {checks.touched ? `${words(count)} selected` : ""}
            </p>
          )}
          {result.state === "ready" && result.notice !== undefined && (
            <p role="status" className="px-3 py-2 text-xs text-support">
              {result.notice}
            </p>
          )}
          {ask ? (
            <Asked message={ask.validate(value)} prompt={ask.prompt} />
          ) : result.state === "failed" ? (
            <p className="px-3 py-3 text-xs text-error">{result.message}</p>
          ) : (
            result.state === "ready" &&
            items.length === 0 && <QuickInputEmpty>No results</QuickInputEmpty>
          )}
          {groups.map(({ group, items: rows }) => (
            <QuickInputGroup key={group ?? ""} heading={group}>
              {rows.map((item) => (
                <Row
                  key={item.id}
                  id={rowIds.get(item)}
                  item={item}
                  cursor={item === active}
                  on={on(item)}
                  many={many}
                  onPoint={() => {
                    setCursor({ value, id: item.id });
                  }}
                  onSelect={() => {
                    if (on(item) !== undefined && checks.touched) toggle(item);
                    else accept(item, { side: false });
                  }}
                  onToggle={() => {
                    toggle(item);
                  }}
                />
              ))}
            </QuickInputGroup>
          ))}
        </QuickInputList>
        <Footer
          provider={provider}
          moves={!ask}
          acceptable={active?.disabled !== true}
          many={many}
          acceptLabel={
            ask?.acceptLabel ??
            (pick
              ? "Select"
              : closes
                ? "Close"
                : many && checks.touched && !action
                  ? `Apply · ${words(count)}`
                  : alone
                    ? (provider.acceptAloneLabel ?? provider.acceptLabel)
                    : provider?.acceptLabel)
          }
        />
      </QuickInput>
    </div>
  );
}

/** Under an input: what Enter does, or why it cannot. */
function Asked({
  prompt,
  message,
}: {
  prompt: string;
  message: string | undefined;
}) {
  return message === undefined ? (
    <p className="px-3 py-2.5 text-xs text-support">{prompt}</p>
  ) : (
    <p role="alert" className="px-3 py-2.5 text-xs text-error">
      {message}
    </p>
  );
}

function Row({
  id,
  item,
  cursor,
  on,
  many,
  onPoint,
  onSelect,
  onToggle,
}: {
  id: string | undefined;
  item: QuickPickItem;
  cursor: boolean;
  /** Whether it is ticked; none for a row with no box. */
  on: boolean | undefined;
  /** The list has rows with a box, which a row without one lines up with. */
  many: boolean;
  onPoint: () => void;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { platform } = useWorkbench();
  const Icon = item.icon;
  return (
    // Among rows to tick, `aria-selected` says what is ticked, never where the cursor is.
    <QuickInputOption
      id={id}
      cursor={cursor}
      aria-disabled={item.disabled}
      aria-selected={many ? on : cursor}
      onPointerMove={onPoint}
      onClick={(event) => {
        if (
          on !== undefined &&
          (platform === "mac" ? event.metaKey : event.ctrlKey)
        ) {
          onToggle();
        } else {
          onSelect();
        }
      }}
      className={item.tile ? "h-9" : item.disabled ? "text-support" : undefined}
    >
      {on !== undefined && (
        <span
          className="-ml-2 flex h-full items-center pl-2"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <Tick on={on} />
        </span>
      )}
      {many && on === undefined && !item.tile && !Icon && (
        <span aria-hidden className="w-3.5 shrink-0" />
      )}
      {item.tile && (
        <Tile
          letters={initials(item.tile.name)}
          color={item.tile.color}
          size="sm"
        />
      )}
      {Icon && <Icon aria-hidden className="size-3.5 text-support" />}
      <HighlightedLabel
        text={item.label}
        ranges={item.matches ?? []}
        className="min-w-0"
      />
      {item.description && (
        <span className="min-w-0 shrink-[3] truncate text-xs text-support">
          {item.description}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2 text-xs text-support">
        {item.state && (
          <StatusLabel
            tone={item.state.tone}
            pulse={item.state.pulse}
            hollow={item.state.hollow}
            className="max-w-56"
          >
            {item.state.label}
          </StatusLabel>
        )}
        {item.kind && (
          <span className="w-20 truncate text-right text-quiet">
            {item.kind}
          </span>
        )}
        {item.keybinding && <Kbd>{item.keybinding}</Kbd>}
      </span>
    </QuickInputOption>
  );
}

/**
 * The keys of what quick access does, as the keybinding registry binds
 * them, and on the empty prefix the prefixes the providers name.
 */
function Footer({
  provider,
  moves,
  acceptable,
  many,
  acceptLabel,
}: {
  provider: QuickAccessProvider | undefined;
  /** Whether it shows rows to move through; an input does not. */
  moves: boolean;
  /** Whether Enter does anything: not on a row that cannot be chosen. */
  acceptable: boolean;
  many: boolean;
  /** What Enter does: `Open` unless it says. */
  acceptLabel: string | undefined;
}) {
  const { keybindings, quickAccess } = useWorkbench();
  useChanges(keybindings.changes);
  const keysOf = (command: string) => {
    const binding = keybindings.primary(command);
    return binding ? [keybindings.label(binding.presses)] : [];
  };
  const move = [...keysOf(QUICK_INPUT.previous), ...keysOf(QUICK_INPUT.next)];
  const accept = keysOf(QUICK_INPUT.accept);
  const toggle = many ? keysOf(QUICK_INPUT.toggle) : [];
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
      className="flex h-[30px] shrink-0 items-center gap-3.5 border-t border-border px-3 text-2xs whitespace-nowrap text-support"
    >
      {moves && move.length > 0 && <Hint keys={move}>Move</Hint>}
      {toggle.length > 0 && <Hint keys={toggle}>Add or remove</Hint>}
      {acceptable && accept.length > 0 && (
        <Hint keys={accept}>{acceptLabel ?? "Open"}</Hint>
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
