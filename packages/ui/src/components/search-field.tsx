import type { ReactNode, Ref } from "react";
import { ListFilter, X, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { Kbd } from "./kbd";

/**
 * A one-line text field for filtering or searching: an icon, the text, a
 * clear button once there is text, and otherwise the key that focuses it.
 * Escape clears it, then leaves it.
 */
export function SearchField({
  label,
  value,
  onChange,
  placeholder,
  icon: Icon = ListFilter,
  keys,
  inputRef,
  trailing,
  onEnter,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  icon?: LucideIcon;
  /** The key that focuses the field, shown while it is empty. */
  keys?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** What follows the text while there is some, such as a search's `3 of 5`. */
  trailing?: ReactNode;
  /** Enter, or Shift+Enter, such as a search's step to its next match or back. */
  onEnter?: (back: boolean) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md bg-editor px-2 text-xs text-muted-foreground shadow-[inset_0_0_0_1px_var(--input)] focus-within:shadow-[inset_0_0_0_1px_var(--ring)]",
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <input
        ref={inputRef}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onEnter) {
            event.preventDefault();
            onEnter(event.shiftKey);
            return;
          }
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (value) onChange("");
          else event.currentTarget.blur();
        }}
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground-2"
      />
      {value && trailing}
      {value ? (
        <button
          type="button"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => {
            onChange("");
          }}
          className="flex size-4 items-center justify-center rounded hover:bg-row-hover hover:text-foreground"
        >
          <X aria-hidden className="size-3" />
        </button>
      ) : (
        keys && <Kbd>{keys}</Kbd>
      )}
    </div>
  );
}
