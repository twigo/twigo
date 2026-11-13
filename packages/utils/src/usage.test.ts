import { expect, test } from "vitest";
import {
  formatCpu,
  formatCpuAdaptive,
  formatMemory,
  formatMemoryAdaptive,
} from "./usage";

test.each([
  [0, "0m"],
  [1, "1m"],
  [999_969, "1m"],
  [1_000_000, "1m"],
  [1_000_001, "2m"],
  [49_877_349, "50m"],
  [1_250_000_000, "1250m"],
])("%d nanocores read %s", (nanocores, text) => {
  expect(formatCpu(nanocores)).toBe(text);
});

test.each([
  [0, "0Mi"],
  [836 * 1024, "0Mi"],
  [1024 * 1024 - 1, "0Mi"],
  [1024 * 1024, "1Mi"],
  [34 * 1024 * 1024 + 900_000, "34Mi"],
  [1536 * 1024 * 1024, "1536Mi"],
])("%d bytes read %s", (bytes, text) => {
  expect(formatMemory(bytes)).toBe(text);
});

test.each([
  [0, "0m"],
  [999_000_000, "999m"],
  [999_000_001, "1"],
  [1_000_000_000, "1"],
  [1_250_000_000, "1.25"],
  [16_000_000_000, "16"],
  [2_005_000_000, "2"],
])("%d nanocores read %s adaptively", (nanocores, text) => {
  expect(formatCpuAdaptive(nanocores)).toBe(text);
});

test.each([
  [34 * 1024 * 1024 + 900_000, "34Mi"],
  [1023 * 1024 * 1024 + 1000, "1023Mi"],
  [1024 * 1024 * 1024, "1Gi"],
  [1536 * 1024 * 1024, "1.5Gi"],
  [16_355_060 * 1024, "15.59Gi"],
])("%d bytes read %s adaptively", (bytes, text) => {
  expect(formatMemoryAdaptive(bytes)).toBe(text);
});
