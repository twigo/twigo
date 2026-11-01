import { useEffect, useRef } from "react";
import { ListFilter, X } from "lucide-react";
import { useChanges } from "@twigo/workbench";
import type { ListFilters } from "./filters";
import { parseListUri } from "./uri";

/** The text a list editor's rows are filtered by. */
export function FilterField({
  uri,
  filters,
}: {
  uri: string;
  filters: ListFilters;
}) {
  useChanges(filters.changes);
  const input = useRef<HTMLInputElement>(null);
  const request = filters.focusRequest(uri);
  useEffect(() => {
    if (request > 0) input.current?.focus();
  }, [request]);
  const value = filters.text(uri) ?? parseListUri(uri)?.text ?? "";
  return (
    <div className="flex h-6 w-56 items-center gap-1.5 rounded-md border border-border bg-foreground/5 px-2 text-[12px] text-muted-foreground focus-within:border-ring">
      <ListFilter aria-hidden className="size-3.5 shrink-0" />
      <input
        ref={input}
        value={value}
        aria-label="Filter rows"
        placeholder="Filter"
        spellCheck={false}
        onChange={(event) => {
          filters.setText(uri, event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (value) filters.setText(uri, "");
          else input.current?.blur();
        }}
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => {
            filters.setText(uri, "");
          }}
          className="flex size-4 items-center justify-center rounded hover:bg-row-hover"
        >
          <X aria-hidden className="size-3" />
        </button>
      )}
    </div>
  );
}
