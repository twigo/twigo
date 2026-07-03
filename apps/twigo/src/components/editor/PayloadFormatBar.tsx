import {
  Select as SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectSeparator,
} from "@twigo/ui";
import { useCodecs } from "@/store/codecs";
import { CODEC_LABELS, type DecodeTarget } from "@/lib/codecs";
import type { CodecId } from "@/lib/api";

const BUILTINS: { id: string; label: string }[] = [
  { id: "json", label: "JSON" },
  { id: "text", label: "Text" },
  { id: "hex", label: "Hex" },
];

const CODECS: CodecId[] = ["protobuf", "msgpack", "cbor"];

function targetId(t: DecodeTarget): string {
  return t.kind === "builtin" ? t.format : t.codec;
}

export function PayloadFormatBar({
  value,
  onChange,
  className,
}: {
  value: DecodeTarget;
  onChange: (t: DecodeTarget) => void;
  className?: string;
}) {
  const schemas = useCodecs((s) => s.schemas);

  const pickFormat = (id: string) => {
    if (id === "json" || id === "text" || id === "hex") {
      onChange({ kind: "builtin", format: id });
      return;
    }
    const codec = id as CodecId;
    if (codec === "protobuf") {
      const schema = schemas[0];
      onChange({
        kind: "codec",
        codec,
        schemaId: schema?.id,
        messageType: schema?.messageTypes[0],
      });
    } else {
      onChange({ kind: "codec", codec });
    }
  };

  const schema =
    value.kind === "codec" && value.codec === "protobuf"
      ? useCodecs.getState().schemaById(value.schemaId)
      : undefined;

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5">
        <SelectRoot value={targetId(value)} onValueChange={pickFormat}>
          <SelectTrigger className="h-6 w-28 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BUILTINS.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.label}
              </SelectItem>
            ))}
            <SelectSeparator />
            {CODECS.map((c) => (
              <SelectItem
                key={c}
                value={c}
                disabled={c === "protobuf" && schemas.length === 0}
              >
                {CODEC_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>

        {value.kind === "codec" && value.codec === "protobuf" && (
          <>
            <SelectRoot
              value={value.schemaId ?? ""}
              onValueChange={(id) => {
                const next = useCodecs.getState().schemaById(id);
                onChange({
                  ...value,
                  schemaId: id,
                  messageType: next?.messageTypes[0],
                });
              }}
            >
              <SelectTrigger className="h-6 w-32 text-[11px]">
                <SelectValue placeholder="schema" />
              </SelectTrigger>
              <SelectContent>
                {schemas.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
            <SelectRoot
              value={value.messageType ?? ""}
              onValueChange={(t) => onChange({ ...value, messageType: t })}
            >
              <SelectTrigger className="h-6 w-40 text-[11px]">
                <SelectValue placeholder="message type" />
              </SelectTrigger>
              <SelectContent>
                {(schema?.messageTypes ?? []).map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
          </>
        )}
      </div>
    </div>
  );
}
