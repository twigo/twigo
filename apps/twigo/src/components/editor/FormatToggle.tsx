import { ToggleGroup, ToggleGroupItem } from "@twigo/ui";

export type PayloadFormat = "json" | "text" | "hex";

const FORMATS: PayloadFormat[] = ["json", "text", "hex"];

// The JSON/Text/Hex switcher shared by the message inspector, KV entry viewer
// and JetStream message browser. Content is rendered by each caller; this only
// owns the mode choice (a segmented control, not tabs-with-panels).
export function FormatToggle({
  value,
  onChange,
  className,
}: {
  value: PayloadFormat;
  onChange: (format: PayloadFormat) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // single-select emits "" when the active item is re-clicked; a payload
      // always has a format, so ignore the deselect.
      onValueChange={(v) => {
        if (v) onChange(v as PayloadFormat);
      }}
      className={className}
      aria-label="Payload format"
    >
      {FORMATS.map((f) => (
        <ToggleGroupItem
          key={f}
          value={f}
          className="text-[10px] uppercase tracking-wider"
        >
          {f}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
