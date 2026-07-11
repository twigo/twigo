import { useState } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import {
  Button,
  Input,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Select as SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectSeparator,
  cn,
} from "@twigo/ui";
import {
  useCodecs,
  subjectMatches,
  validPattern,
  type Mapping,
} from "@/store/codecs";
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

function mappingMatchesTarget(m: Mapping, t: DecodeTarget): boolean {
  return (
    t.kind === "codec" &&
    m.codec === t.codec &&
    (t.codec !== "protobuf" ||
      (m.schemaId === t.schemaId && m.messageType === t.messageType))
  );
}

function MappingPin({
  connId,
  subject,
  value,
}: {
  connId: string;
  subject: string;
  value: DecodeTarget;
}) {
  const mapping = useCodecs((s) => s.resolve(connId, subject));
  const [open, setOpen] = useState(false);
  const [pattern, setPattern] = useState("");

  if (value.kind !== "codec" && !mapping) return null;

  const mapped = mapping !== null && mappingMatchesTarget(mapping, value);
  const trimmed = pattern.trim();
  const valid = validPattern(trimmed);

  const openChange = (next: boolean) => {
    if (next) setPattern(mapping?.pattern ?? subject);
    setOpen(next);
  };

  const save = () => {
    if (value.kind !== "codec" || !valid) return;
    useCodecs.getState().addMapping(connId, {
      pattern: trimmed,
      codec: value.codec,
      schemaId: value.codec === "protobuf" ? value.schemaId : undefined,
      messageType: value.codec === "protobuf" ? value.messageType : undefined,
    });
    setOpen(false);
  };

  const remove = () => {
    if (mapping) useCodecs.getState().removeMapping(connId, mapping.id);
    setOpen(false);
  };

  const label = mapping
    ? mapped
      ? `Mapped via ${mapping.pattern}`
      : `Mapped via ${mapping.pattern} - update or remove`
    : "Remember codec for this subject";

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={label}
          className={cn(mapped && "text-brand")}
        >
          {mapped ? <BookmarkCheck /> : <Bookmark />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3">
        {value.kind === "codec" ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <p className="text-xs text-muted-foreground">
              Subjects matching this pattern decode as{" "}
              {CODEC_LABELS[value.codec]}
              {value.messageType ? ` (${value.messageType})` : ""}.
            </p>
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              spellCheck={false}
              aria-label="Subject pattern"
              className="h-7 font-mono text-xs"
            />
            {valid && !subjectMatches(trimmed, subject) && (
              <p className="text-[11px] text-warn">
                Pattern does not match {subject}.
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <Button type="submit" size="sm" disabled={!valid}>
                Save mapping
              </Button>
              {mapping && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-error"
                  onClick={remove}
                >
                  Remove
                </Button>
              )}
            </div>
          </form>
        ) : (
          mapping && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Mapped via <span className="font-mono">{mapping.pattern}</span>{" "}
                → {CODEC_LABELS[mapping.codec]}
                {mapping.messageType ? ` (${mapping.messageType})` : ""}.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="text-error"
                onClick={remove}
              >
                Remove mapping
              </Button>
            </div>
          )
        )}
      </PopoverContent>
    </Popover>
  );
}

export function PayloadFormatBar({
  value,
  onChange,
  connId,
  subject,
  className,
}: {
  value: DecodeTarget;
  onChange: (t: DecodeTarget) => void;
  connId?: string | null;
  subject?: string | null;
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

        {connId != null && subject != null && (
          <MappingPin connId={connId} subject={subject} value={value} />
        )}
      </div>
    </div>
  );
}
