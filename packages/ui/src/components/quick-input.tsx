import * as React from "react";
import { Search } from "lucide-react";

import { cn } from "../lib/cn";

/** Quick access's surface, for a widget that holds its own cursor. */
function QuickInput({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="quick-input"
      tabIndex={-1}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-lg backdrop-blur-xl dark:bg-popover/96",
        className,
      )}
      {...props}
    />
  );
}

/** The combobox of a listbox: `controls` is the list's id, `active` the id of the row under the cursor, none when no row is. */
function QuickInputField({
  className,
  controls,
  active,
  ...props
}: React.ComponentProps<"input"> & {
  controls: string;
  active: string | undefined;
}) {
  return (
    <div
      data-slot="quick-input-field-wrapper"
      className="flex items-center gap-2 border-b border-border px-2.5"
    >
      <Search aria-hidden className="size-3.5 shrink-0 text-support" />
      <input
        data-slot="quick-input-field"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded
        aria-controls={controls}
        aria-activedescendant={active}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          "flex h-10 w-full bg-transparent text-body outline-none placeholder:text-quiet disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function QuickInputList({
  className,
  multiselectable,
  ...props
}: React.ComponentProps<"div"> & { multiselectable: boolean }) {
  return (
    <div
      data-slot="quick-input-list"
      role="listbox"
      tabIndex={-1}
      aria-label="Suggestions"
      aria-multiselectable={multiselectable || undefined}
      className={cn(
        "max-h-[min(440px,60vh)] overflow-y-auto overflow-x-hidden py-1",
        className,
      )}
      {...props}
    />
  );
}

function QuickInputEmpty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="quick-input-empty"
      className={cn("py-4 text-center text-xs text-support", className)}
      {...props}
    />
  );
}

function QuickInputGroup({
  className,
  heading,
  children,
  ...props
}: React.ComponentProps<"div"> & { heading: string | undefined }) {
  const headingId = React.useId();
  return (
    <div
      data-slot="quick-input-group"
      role="group"
      aria-labelledby={heading ? headingId : undefined}
      className={cn(
        "overflow-hidden px-1.5 text-popover-foreground",
        className,
      )}
      {...props}
    >
      {heading && (
        <div
          id={headingId}
          aria-hidden
          className="px-2 pt-2 pb-1 text-2xs font-medium text-support"
        >
          {heading}
        </div>
      )}
      {children}
    </div>
  );
}

/** A row under the cursor when `selected`; a row with a box says `aria-checked` itself. */
function QuickInputOption({
  className,
  selected,
  ...props
}: React.ComponentProps<"div"> & { selected: boolean }) {
  return (
    <div
      data-slot="quick-input-option"
      role="option"
      aria-selected={selected}
      className={cn(
        "relative flex h-[26px] select-none items-center gap-2 rounded-sm px-2 text-body outline-none",
        "aria-selected:bg-row-active",
        "[&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export {
  QuickInput,
  QuickInputField,
  QuickInputList,
  QuickInputEmpty,
  QuickInputGroup,
  QuickInputOption,
};
