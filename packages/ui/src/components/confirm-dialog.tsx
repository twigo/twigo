import { useId, useRef, useState, type ReactNode } from "react";
import { Check, Copy, type LucideIcon } from "lucide-react";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./dialog";
import { Kbd } from "./kbd";

/** Objects that one thing happens to: `With it go`. */
export interface ConfirmList {
  readonly title: string;
  readonly items: readonly {
    readonly key: string;
    /** `ReplicaSet`, quieter before the name. */
    readonly kind: string;
    readonly name: string;
    /** Its namespace, quiet at the end. */
    readonly detail?: string;
  }[];
}

export interface ConfirmDialogProps {
  /** Says where it acts first: the context's type and name. */
  readonly badge?: ReactNode;
  /** A strip of this colour along the top, for a context whose mode wants to be seen. */
  readonly accent?: string;
  /** Names the cluster: `Delete pod web-1 from kind-a?` */
  readonly question: string;
  /** What follows, a sentence each. */
  readonly consequences: readonly string[];
  /** The exact objects it acts on and those that follow, by what happens to them. */
  readonly lists?: readonly ConfirmList[];
  /** The command line that does the same, shown as code to copy. */
  readonly command?: string;
  /** What the person types before the button works. */
  readonly typed?: string;
  /** The button names its action, never Yes or OK. */
  readonly confirm: string;
  readonly icon?: LucideIcon;
  /** Whether it destroys, which the button's colour says. */
  readonly destructive: boolean;
  readonly onConfirm: (typed: string | undefined) => void;
  readonly onCancel: () => void;
  /** Where the focus goes when it closes; Radix returns it only to a trigger, which this has none. */
  readonly onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Asks before a change that cannot be undone at once (ARCHITECTURE 6.4): the
 * question names the cluster, the dialog lists what follows and the
 * equivalent command, and a typed name holds the button back where the blast
 * radius or the mode asks for one. Focus starts on Cancel, or on the field,
 * so a stray Enter confirms nothing.
 */
export function ConfirmDialog({
  badge,
  accent,
  question,
  consequences,
  lists = [],
  command,
  typed,
  confirm,
  icon: Icon,
  destructive,
  onConfirm,
  onCancel,
  onCloseAutoFocus,
}: ConfirmDialogProps) {
  const [text, setText] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const field = useId();
  const ready = typed === undefined || text === typed;
  const submit = () => {
    if (ready) onConfirm(typed === undefined ? undefined : text);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(82%-24px)] max-w-[480px] flex-col overflow-hidden"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (input.current ?? cancel.current)?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {accent && (
          <div
            aria-hidden
            className="h-1 flex-none"
            style={{ background: accent }}
          />
        )}
        <form
          className="flex min-h-0 flex-col text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto px-[18px] pt-4 pb-1">
            {badge && <div className="flex items-center gap-2">{badge}</div>}
            <DialogTitle className="text-[15px] leading-snug font-semibold wrap-anywhere">
              {question}
            </DialogTitle>
            {consequences.length > 0 ? (
              <DialogDescription asChild>
                <ul className="grid gap-1 text-muted-foreground">
                  {consequences.map((consequence) => (
                    <li key={consequence}>{consequence}</li>
                  ))}
                </ul>
              </DialogDescription>
            ) : (
              <DialogDescription className="sr-only">
                {question}
              </DialogDescription>
            )}
            {lists.map((list) => (
              <Listed key={list.title} list={list} />
            ))}
            {command && <CommandLine command={command} />}
            {typed !== undefined && (
              <div className="grid gap-1.5">
                <label htmlFor={field}>
                  Type <span className="font-mono font-semibold">{typed}</span>{" "}
                  to confirm
                </label>
                <input
                  ref={input}
                  id={field}
                  value={text}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setText(event.target.value);
                  }}
                  className="h-7 rounded-md bg-editor px-2 font-mono text-xs shadow-[inset_0_0_0_1px_var(--input)] outline-none focus:shadow-[inset_0_0_0_1px_var(--ring)]"
                />
              </div>
            )}
          </div>
          <div className="flex flex-none items-center justify-end gap-2 px-[18px] pt-3 pb-4">
            <Button
              ref={cancel}
              type="button"
              size="sm"
              variant="outline"
              onClick={onCancel}
            >
              Cancel
              <Kbd>esc</Kbd>
            </Button>
            <Button
              type="submit"
              size="sm"
              variant={destructive ? "destructive" : "default"}
              disabled={!ready}
            >
              {Icon && <Icon aria-hidden />}
              {confirm}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A list of objects under its title and count, scrolling past a few rows. */
function Listed({ list }: { list: ConfirmList }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="grid gap-1">
      <h3
        id={heading}
        className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground"
      >
        {list.title}
        <span className="font-normal tabular-nums text-muted-foreground-2">
          {list.items.length.toLocaleString("en")}
        </span>
      </h3>
      <ul className="max-h-[132px] overflow-y-auto rounded-md py-1 shadow-[inset_0_0_0_1px_var(--border)]">
        {list.items.map((item) => (
          <li key={item.key} className="flex h-[22px] items-center gap-2 px-2">
            <span className="w-[88px] shrink-0 truncate text-muted-foreground-2">
              {item.kind}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {item.detail && (
              <span className="min-w-0 shrink-[2] truncate text-muted-foreground">
                {item.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A command line in code, with a button that copies it. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-1 rounded-md bg-row-active py-1.5 pr-1 pl-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
      <code className="min-w-0 flex-1 wrap-anywhere whitespace-pre-wrap select-text">
        {command}
      </code>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={copied ? "Copied" : "Copy command"}
        tooltip={copied ? "Copied" : "Copy command"}
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
  );
}
