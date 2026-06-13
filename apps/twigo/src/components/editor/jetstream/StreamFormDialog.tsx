import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
  Button,
  Input,
  FormSection,
  FieldGrid,
  FormField,
} from "@twigo/ui";
import { Select } from "./form";

const STORAGE = ["file", "memory"];
const RETENTION = ["limits", "interest", "workqueue"];
const DISCARD = ["old", "new"];

export interface StreamFormInitial {
  name: string;
  subjects: string;
  storage: string;
  retention: string;
  discard: string;
  maxMsgs: string;
  maxBytes: string;
  maxAgeSec: string;
  replicas: string;
}

export function StreamFormDialog({
  title,
  submitLabel,
  initial,
  // On edit, name/storage/retention can't change - gray them.
  lockIdentity = false,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initial?: StreamFormInitial;
  lockIdentity?: boolean;
  onClose: () => void;
  onSubmit: (config: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [subjects, setSubjects] = useState(initial?.subjects ?? "");
  const [storage, setStorage] = useState(initial?.storage ?? "file");
  const [retention, setRetention] = useState(initial?.retention ?? "limits");
  const [discard, setDiscard] = useState(initial?.discard ?? "old");
  const [maxMsgs, setMaxMsgs] = useState(initial?.maxMsgs ?? "-1");
  const [maxBytes, setMaxBytes] = useState(initial?.maxBytes ?? "-1");
  const [maxAgeSec, setMaxAgeSec] = useState(initial?.maxAgeSec ?? "0");
  const [replicas, setReplicas] = useState(initial?.replicas ?? "1");

  const subjectList = subjects
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = name.trim() !== "" && subjectList.length > 0;

  const submit = () => {
    if (!valid) return;
    onSubmit({
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

  const immutable = lockIdentity ? "Immutable after creation." : undefined;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="p-5">
        <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>

        <div className="mt-4 space-y-5">
          <FormSection title="Stream">
            <FieldGrid>
              <FormField label="Name" hint={immutable}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus={!lockIdentity}
                  disabled={lockIdentity}
                  spellCheck={false}
                  placeholder="ORDERS"
                  className="h-7 font-mono text-xs"
                />
              </FormField>
              <FormField
                label="Subjects"
                hint="Comma-separated; wildcards allowed."
              >
                <Input
                  value={subjects}
                  onChange={(e) => setSubjects(e.target.value)}
                  spellCheck={false}
                  placeholder="orders.>, audit.*"
                  className="h-7 font-mono text-xs"
                />
              </FormField>
            </FieldGrid>
          </FormSection>

          <FormSection title="Storage">
            <FieldGrid>
              <FormField label="Storage" hint={immutable}>
                <Select
                  value={storage}
                  onChange={setStorage}
                  options={STORAGE}
                  disabled={lockIdentity}
                />
              </FormField>
              <FormField label="Retention" hint={immutable}>
                <Select
                  value={retention}
                  onChange={setRetention}
                  options={RETENTION}
                  disabled={lockIdentity}
                />
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
          </FormSection>

          <FormSection title="Limits">
            <FieldGrid>
              <FormField label="Discard policy">
                <Select
                  value={discard}
                  onChange={setDiscard}
                  options={DISCARD}
                />
              </FormField>
              <FormField label="Max messages" hint="-1 = unlimited.">
                <Input
                  value={maxMsgs}
                  onChange={(e) => setMaxMsgs(e.target.value)}
                  inputMode="numeric"
                  className="h-7 w-32 font-mono text-xs"
                />
              </FormField>
              <FormField label="Max bytes" hint="-1 = unlimited.">
                <Input
                  value={maxBytes}
                  onChange={(e) => setMaxBytes(e.target.value)}
                  inputMode="numeric"
                  className="h-7 w-32 font-mono text-xs"
                />
              </FormField>
              <FormField label="Max age (sec)" hint="0 = unlimited.">
                <Input
                  value={maxAgeSec}
                  onChange={(e) => setMaxAgeSec(e.target.value)}
                  inputMode="numeric"
                  className="h-7 w-32 font-mono text-xs"
                />
              </FormField>
            </FieldGrid>
          </FormSection>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" size="sm" disabled={!valid} onClick={submit}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
