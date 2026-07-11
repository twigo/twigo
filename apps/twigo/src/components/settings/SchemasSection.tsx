import { useState } from "react";
import { FileUp, Trash2 } from "lucide-react";
import { Button } from "@twigo/ui";
import { useCodecs } from "@/store/codecs";
import { useConnections } from "@/store/connections";
import { codecImportProtos } from "@/lib/api";
import { CODEC_LABELS } from "@/lib/codecs";
import { SectionTitle } from "./SectionTitle";

export function SchemasSection() {
  const schemas = useCodecs((s) => s.schemas);
  const activeContext = useConnections((s) => s.activeContext);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const importProtos = () => {
    setError(null);
    setBusy(true);
    codecImportProtos()
      .then((s) => {
        if (s)
          useCodecs.getState().addSchema({
            name: s.name,
            descriptorSetB64: s.descriptorSetB64,
            messageTypes: s.messageTypes,
          });
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <SectionTitle>Schemas &amp; codecs</SectionTitle>
      <p className="mb-3 text-xs text-muted-foreground">
        Import Protobuf <span className="font-mono">.proto</span> files here. To
        map a subject, pick a codec in a message inspector and pin it — matching
        messages then decode automatically. MessagePack and CBOR need no schema.
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={importProtos}
        >
          <FileUp />
          Import .proto…
        </Button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>

      {schemas.length > 0 && (
        <div className="mt-3 space-y-2">
          {schemas.map((s) => (
            <div
              key={s.id}
              className="rounded-md border border-border p-2.5 text-xs"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <span className="text-muted-foreground">
                  {s.messageTypes.length} message type
                  {s.messageTypes.length === 1 ? "" : "s"}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove schema ${s.name}`}
                  className="ml-auto text-error"
                  onClick={() => useCodecs.getState().removeSchema(s.id)}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {s.messageTypes.map((t) => (
                  <span
                    key={t}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 className="mb-2 mt-6 text-sm font-semibold">Subject mappings</h3>
      {!activeContext ? (
        <p className="text-xs text-muted-foreground">
          Select a connection to see its subject mappings.
        </p>
      ) : (
        <MappingsList connId={activeContext} />
      )}
    </>
  );
}

function MappingsList({ connId }: { connId: string }) {
  const mappings = useCodecs((s) => s.mappings[connId]) ?? [];

  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        Mappings for <span className="font-mono">{connId}</span>.
        {mappings.length === 0 && " None yet — pin one from a message."}
      </p>

      {mappings.map((m) => (
        <div
          key={m.id}
          className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
        >
          <span className="font-mono">{m.pattern}</span>
          <span className="text-muted-foreground">→</span>
          <span>{CODEC_LABELS[m.codec]}</span>
          {m.messageType && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {m.messageType}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove mapping"
            className="ml-auto text-error"
            onClick={() => useCodecs.getState().removeMapping(connId, m.id)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  );
}
