import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, Button, Input } from "@twigo/ui";
import { Field, Select } from "./form";

const ACK = ["explicit", "all", "none"];
const DELIVER = ["all", "last", "new"];

export function CreateConsumerDialog({
  stream,
  onClose,
  onCreate,
}: {
  stream: string;
  onClose: () => void;
  onCreate: (config: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const [ackPolicy, setAckPolicy] = useState("explicit");
  const [deliverPolicy, setDeliverPolicy] = useState("all");

  const filters = filter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = name.trim() !== "";

  const submit = () => {
    if (!valid) return;
    const config: Record<string, unknown> = {
      durable_name: name.trim(),
      name: name.trim(),
      ack_policy: ackPolicy,
      deliver_policy: deliverPolicy,
    };
    if (filters.length === 1) config.filter_subject = filters[0];
    else if (filters.length > 1) config.filter_subjects = filters;
    onCreate(config);
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
          New consumer on {stream}
        </DialogTitle>

        <div className="mt-3 space-y-2">
          <Field label="Durable name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              spellCheck={false}
              placeholder="worker"
              className="h-7 w-40 font-mono text-xs"
            />
          </Field>
          <Field label="Filter subjects (comma, optional)">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
              placeholder="orders.>"
              className="h-7 w-40 font-mono text-xs"
            />
          </Field>
          <Field label="Ack policy">
            <Select value={ackPolicy} onChange={setAckPolicy} options={ACK} />
          </Field>
          <Field label="Deliver policy">
            <Select
              value={deliverPolicy}
              onChange={setDeliverPolicy}
              options={DELIVER}
            />
          </Field>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Creates a durable pull consumer.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid} onClick={submit}>
            Create consumer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
