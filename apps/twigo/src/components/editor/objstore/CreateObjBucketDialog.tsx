import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, Button, Input } from "@twigo/ui";
import { Field, Select } from "@/components/editor/jetstream/form";

const STORAGE = ["file", "memory"];

export function CreateObjBucketDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (config: Record<string, unknown>) => void;
}) {
  const [bucket, setBucket] = useState("");
  const [description, setDescription] = useState("");
  const [ttlSec, setTtlSec] = useState("0");
  const [storage, setStorage] = useState("file");
  const [replicas, setReplicas] = useState("1");

  const valid = bucket.trim() !== "";

  const submit = () => {
    if (!valid) return;
    onCreate({
      bucket: bucket.trim(),
      description: description.trim(),
      maxAge: (Number(ttlSec) || 0) * 1_000_000_000,
      storage,
      numReplicas: Number(replicas) || 1,
    });
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
          New object store
        </DialogTitle>

        <div className="mt-3 space-y-2">
          <Field label="Name">
            <Input
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              autoFocus
              spellCheck={false}
              placeholder="assets"
              className="h-7 w-44 font-mono text-xs"
            />
          </Field>
          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              spellCheck={false}
              className="h-7 w-44 text-xs"
            />
          </Field>
          <Field label="TTL sec (0 = ∞)">
            <Input
              value={ttlSec}
              onChange={(e) => setTtlSec(e.target.value)}
              inputMode="numeric"
              className="h-7 w-44 font-mono text-xs"
            />
          </Field>
          <Field label="Storage">
            <Select value={storage} onChange={setStorage} options={STORAGE} />
          </Field>
          <Field label="Replicas">
            <Input
              value={replicas}
              onChange={(e) => setReplicas(e.target.value)}
              inputMode="numeric"
              className="h-7 w-44 font-mono text-xs"
            />
          </Field>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid} onClick={submit}>
            Create store
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
