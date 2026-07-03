import { describe, it, expect } from "vitest";
import {
  buildConsumerConfig,
  consumerFormValid,
  type ConsumerForm,
} from "./consumerForm";

const base: ConsumerForm = {
  name: "worker",
  filter: "",
  ackPolicy: "explicit",
  deliverPolicy: "all",
  startSeq: "",
  startTime: "",
  replayPolicy: "instant",
};

describe("consumerFormValid", () => {
  it("requires a name", () => {
    expect(consumerFormValid({ ...base, name: " " })).toBe(false);
    expect(consumerFormValid(base)).toBe(true);
  });

  it("gates start-seq and start-time policies on their anchors", () => {
    expect(
      consumerFormValid({ ...base, deliverPolicy: "by_start_sequence" }),
    ).toBe(false);
    expect(
      consumerFormValid({
        ...base,
        deliverPolicy: "by_start_sequence",
        startSeq: "42",
      }),
    ).toBe(true);
    expect(consumerFormValid({ ...base, deliverPolicy: "by_start_time" })).toBe(
      false,
    );
    expect(
      consumerFormValid({
        ...base,
        deliverPolicy: "by_start_time",
        startTime: "2026-07-03T12:00:00Z",
      }),
    ).toBe(true);
  });
});

describe("buildConsumerConfig", () => {
  it("emits the flattened deliver-policy anchors", () => {
    expect(
      buildConsumerConfig({
        ...base,
        deliverPolicy: "by_start_sequence",
        startSeq: "42",
      }),
    ).toMatchObject({ deliver_policy: "by_start_sequence", opt_start_seq: 42 });
    expect(
      buildConsumerConfig({
        ...base,
        deliverPolicy: "by_start_time",
        startTime: "2026-07-03T12:00:00Z",
      }),
    ).toMatchObject({
      deliver_policy: "by_start_time",
      opt_start_time: "2026-07-03T12:00:00.000Z",
    });
  });

  it("splits filters and includes replay only when original", () => {
    expect(buildConsumerConfig({ ...base, filter: "a.>" })).toMatchObject({
      filter_subject: "a.>",
    });
    expect(buildConsumerConfig({ ...base, filter: "a.>, b.>" })).toMatchObject({
      filter_subjects: ["a.>", "b.>"],
    });
    expect(buildConsumerConfig(base)).not.toHaveProperty("replay_policy");
    expect(
      buildConsumerConfig({ ...base, replayPolicy: "original" }),
    ).toMatchObject({ replay_policy: "original" });
  });
});
