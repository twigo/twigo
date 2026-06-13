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
import { Select } from "@/components/editor/jetstream/form";

const STORAGE = ["file", "memory"];

export function CreateBucketDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (config: Record<string, unknown>) => void;
}) {
  const [bucket, setBucket] = useState("");
  const [history, setHistory] = useState("1");
  const [ttlSec, setTtlSec] = useState("0");
  const [storage, setStorage] = useState("file");
  const [replicas, setReplicas] = useState("1");

  const valid = bucket.trim() !== "";

  const submit = () => {
    if (!valid) return;
    onCreate({
      bucket: bucket.trim(),
      history: Number(history) || 1,
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
      <DialogContent className="p-5">
        <DialogTitle className="text-sm font-semibold">New bucket</DialogTitle>

        <FieldGrid className="mt-4">
          <FormField label="Name">
            <Input
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              autoFocus
              spellCheck={false}
              placeholder="config"
              className="h-7 font-mono text-xs"
            />
          </FormField>
          <FormField label="History per key">
            <Input
              value={history}
              onChange={(e) => setHistory(e.target.value)}
              inputMode="numeric"
              className="h-7 w-32 font-mono text-xs"
            />
          </FormField>
          <FormField label="TTL (sec)" hint="0 = no expiry.">
            <Input
              value={ttlSec}
              onChange={(e) => setTtlSec(e.target.value)}
              inputMode="numeric"
              className="h-7 w-32 font-mono text-xs"
            />
          </FormField>
          <FormField label="Storage">
            <Select value={storage} onChange={setStorage} options={STORAGE} />
          </FormField>
          <FormField label="Replicas">
            <Input
              value={replicas}
              onChange={(e) => setReplicas(e.target.value)}
              inputMode="numeric"
              className="h-7 w-24 font-mono text-xs"
            />
          </FormField>
        </FieldGrid>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" size="sm" disabled={!valid} onClick={submit}>
            Create bucket
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
