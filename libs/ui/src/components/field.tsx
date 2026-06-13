import { cn } from "../lib/cn";

// Form recipes so every dialog and settings pane shares one rhythm: titled
// groups, one aligned label column, hints under the control.
// Compose: FormSection > FieldGrid > FormField.

export function FormSection({
  title,
  className,
  children,
}: {
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("space-y-2.5", className)}>
      {title && (
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}

export function FieldGrid({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(8rem,max-content)_1fr] items-start gap-x-4 gap-y-2.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function FormField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <label htmlFor={htmlFor} className="pt-1.5 text-xs text-muted-foreground">
        {label}
      </label>
      <div className="min-w-0 space-y-1">
        {children}
        {hint && <p className="text-[11px] text-muted-foreground-2">{hint}</p>}
      </div>
    </>
  );
}
