import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Input,
  FieldGrid,
  FormField,
} from "@twigo/ui";
import { Select } from "./form";

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
      <DialogContent className="p-5">
        <DialogTitle className="text-sm font-semibold">
          New consumer on {stream}
        </DialogTitle>
        <DialogDescription className="mt-1 text-xs text-muted-foreground">
          Creates a durable pull consumer.
        </DialogDescription>

        <FieldGrid className="mt-4">
          <FormField label="Durable name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              spellCheck={false}
              placeholder="worker"
              className="h-7 font-mono text-xs"
            />
          </FormField>
          <FormField label="Filter subjects" hint="Optional; comma-separated.">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
              placeholder="orders.>"
              className="h-7 font-mono text-xs"
            />
          </FormField>
          <FormField label="Ack policy">
            <Select value={ackPolicy} onChange={setAckPolicy} options={ACK} />
          </FormField>
          <FormField label="Deliver policy">
            <Select
              value={deliverPolicy}
              onChange={setDeliverPolicy}
              options={DELIVER}
            />
          </FormField>
        </FieldGrid>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" size="sm" disabled={!valid} onClick={submit}>
            Create consumer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
