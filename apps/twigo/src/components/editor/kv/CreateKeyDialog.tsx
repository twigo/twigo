import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, Button, Input } from "@twigo/ui";
import { Field } from "@/components/editor/jetstream/form";

export function CreateKeyDialog({
  bucket,
  onClose,
  onCreate,
}: {
  bucket: string;
  onClose: () => void;
  onCreate: (key: string, value: string) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const valid = key.trim() !== "";

  const submit = () => {
    if (!valid) return;
    onCreate(key.trim(), value);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="p-4">
        <DialogTitle className="text-sm font-semibold">
          New key in {bucket}
        </DialogTitle>

        <div className="mt-3 space-y-2">
          <Field label="Key">
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
              spellCheck={false}
              placeholder="db.host"
              className="h-7 w-40 font-mono text-xs"
            />
          </Field>
          <div>
            <span className="text-xs text-muted-foreground">Value</span>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              spellCheck={false}
              className="mt-1 h-24 w-full resize-none rounded border border-border bg-background p-2 font-mono text-xs"
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid} onClick={submit}>
            Create key
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
