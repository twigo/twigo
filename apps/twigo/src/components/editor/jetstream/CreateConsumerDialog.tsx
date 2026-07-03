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
import {
  buildConsumerConfig,
  consumerFormValid,
  type ConsumerForm,
} from "./consumerForm";

const ACK = ["explicit", "all", "none"];
const DELIVER = [
  "all",
  "last",
  "new",
  "last_per_subject",
  "by_start_sequence",
  "by_start_time",
];
const REPLAY = ["instant", "original"];

export function CreateConsumerDialog({
  stream,
  initialStartSeq,
  onClose,
  onCreate,
}: {
  stream: string;
  initialStartSeq?: number;
  onClose: () => void;
  onCreate: (config: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const [ackPolicy, setAckPolicy] = useState("explicit");
  const [deliverPolicy, setDeliverPolicy] = useState(
    initialStartSeq === undefined ? "all" : "by_start_sequence",
  );
  const [startSeq, setStartSeq] = useState(
    initialStartSeq === undefined ? "" : String(initialStartSeq),
  );
  const [startTime, setStartTime] = useState("");
  const [replayPolicy, setReplayPolicy] = useState("instant");

  const form: ConsumerForm = {
    name,
    filter,
    ackPolicy,
    deliverPolicy,
    startSeq,
    startTime,
    replayPolicy,
  };
  const valid = consumerFormValid(form);

  const submit = () => {
    if (!valid) return;
    onCreate(buildConsumerConfig(form));
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
          {deliverPolicy === "by_start_sequence" && (
            <FormField label="Start sequence">
              <Input
                value={startSeq}
                onChange={(e) => setStartSeq(e.target.value)}
                inputMode="numeric"
                placeholder="1"
                className="h-7 w-32 font-mono text-xs"
              />
            </FormField>
          )}
          {deliverPolicy === "by_start_time" && (
            <FormField
              label="Start time"
              hint="RFC3339 or anything Date-parseable."
            >
              <Input
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                spellCheck={false}
                placeholder="2026-07-03T12:00:00Z"
                className="h-7 font-mono text-xs"
              />
            </FormField>
          )}
          <FormField
            label="Replay"
            hint="original re-delivers at the recorded rate."
          >
            <Select
              value={replayPolicy}
              onChange={setReplayPolicy}
              options={REPLAY}
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
