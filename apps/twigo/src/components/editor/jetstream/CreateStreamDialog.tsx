import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, Button, Input } from "@twigo/ui";
import { Field, Select } from "./form";

const STORAGE = ["file", "memory"];
const RETENTION = ["limits", "interest", "workqueue"];
const DISCARD = ["old", "new"];

export function CreateStreamDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (config: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState("");
  const [subjects, setSubjects] = useState("");
  const [storage, setStorage] = useState("file");
  const [retention, setRetention] = useState("limits");
  const [discard, setDiscard] = useState("old");
  const [maxMsgs, setMaxMsgs] = useState("-1");
  const [maxBytes, setMaxBytes] = useState("-1");
  const [maxAgeSec, setMaxAgeSec] = useState("0");
  const [replicas, setReplicas] = useState("1");

  const subjectList = subjects
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = name.trim() !== "" && subjectList.length > 0;

  const submit = () => {
    if (!valid) return;
    onCreate({
      name: name.trim(),
      subjects: subjectList,
      storage,
      retention,
      discard,
      max_msgs: Number(maxMsgs) || -1,
      max_bytes: Number(maxBytes) || -1,
      max_age: (Number(maxAgeSec) || 0) * 1_000_000_000,
      num_replicas: Number(replicas) || 1,
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
        <DialogTitle className="text-sm font-semibold">New stream</DialogTitle>

        <div className="mt-3 space-y-2">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              spellCheck={false}
              placeholder="ORDERS"
              className="h-7 w-40 font-mono text-xs"
            />
          </Field>
          <Field label="Subjects (comma-separated)">
            <Input
              value={subjects}
              onChange={(e) => setSubjects(e.target.value)}
              spellCheck={false}
              placeholder="orders.>"
              className="h-7 w-40 font-mono text-xs"
            />
          </Field>
          <Field label="Storage">
            <Select value={storage} onChange={setStorage} options={STORAGE} />
          </Field>
          <Field label="Retention">
            <Select
              value={retention}
              onChange={setRetention}
              options={RETENTION}
            />
          </Field>
          <Field label="Discard">
            <Select value={discard} onChange={setDiscard} options={DISCARD} />
          </Field>
          <Field label="Max messages (-1 = ∞)">
            <Input
              value={maxMsgs}
              onChange={(e) => setMaxMsgs(e.target.value)}
              inputMode="numeric"
              className="h-7 w-40 font-mono text-xs"
            />
          </Field>
          <Field label="Max bytes (-1 = ∞)">
            <Input
              value={maxBytes}
              onChange={(e) => setMaxBytes(e.target.value)}
              inputMode="numeric"
              className="h-7 w-40 font-mono text-xs"
            />
          </Field>
          <Field label="Max age sec (0 = ∞)">
            <Input
              value={maxAgeSec}
              onChange={(e) => setMaxAgeSec(e.target.value)}
              inputMode="numeric"
              className="h-7 w-40 font-mono text-xs"
            />
          </Field>
          <Field label="Replicas">
            <Input
              value={replicas}
              onChange={(e) => setReplicas(e.target.value)}
              inputMode="numeric"
              className="h-7 w-40 font-mono text-xs"
            />
          </Field>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid} onClick={submit}>
            Create stream
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
