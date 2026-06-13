import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
  Button,
  Input,
  FieldGrid,
  FormField,
} from "@twigo/ui";

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
      <DialogContent className="p-5">
        <DialogTitle className="text-sm font-semibold">
          New key in {bucket}
        </DialogTitle>

        <FieldGrid className="mt-4">
          <FormField label="Key">
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
              spellCheck={false}
              placeholder="db.host"
              className="h-7 font-mono text-xs"
            />
          </FormField>
          <FormField label="Value">
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              spellCheck={false}
              className="h-24 w-full resize-none rounded border border-border bg-background p-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </FormField>
        </FieldGrid>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" size="sm" disabled={!valid} onClick={submit}>
            Create key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
