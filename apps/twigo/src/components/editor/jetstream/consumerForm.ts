export interface ConsumerForm {
  name: string;
  filter: string;
  ackPolicy: string;
  deliverPolicy: string;
  startSeq: string;
  startTime: string;
  replayPolicy: string;
}

export function consumerFormValid(f: ConsumerForm): boolean {
  if (f.name.trim() === "") return false;
  if (f.deliverPolicy === "by_start_sequence") {
    const n = Number(f.startSeq);
    return Number.isInteger(n) && n > 0;
  }
  if (f.deliverPolicy === "by_start_time") {
    return !Number.isNaN(Date.parse(f.startTime));
  }
  return true;
}

export function buildConsumerConfig(f: ConsumerForm): Record<string, unknown> {
  const config: Record<string, unknown> = {
    durable_name: f.name.trim(),
    name: f.name.trim(),
    ack_policy: f.ackPolicy,
    deliver_policy: f.deliverPolicy,
  };
  const filters = f.filter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (filters.length === 1) config.filter_subject = filters[0];
  else if (filters.length > 1) config.filter_subjects = filters;
  if (f.deliverPolicy === "by_start_sequence") {
    config.opt_start_seq = Number(f.startSeq);
  }
  if (f.deliverPolicy === "by_start_time") {
    config.opt_start_time = new Date(f.startTime).toISOString();
  }
  if (f.replayPolicy === "original") config.replay_policy = "original";
  return config;
}
