import { ScrollText } from "lucide-react";
import { expect, test } from "vitest";
import type { LineItem } from "./LineList";
import { continues, timeAfter } from "./roles";

const line = (time: string): LineItem => ({
  kind: "line",
  key: time,
  tag: "h8lbx",
  time,
  text: "",
  runs: [],
  marks: [],
});

const marker: LineItem = {
  kind: "marker",
  key: "m",
  icon: ScrollText,
  text: "Container api exited",
};

test.each([
  ["12:04:05.123", "12:04:04.987", "12:04:", "05.123"],
  ["12:05:00.001", "12:04:59.999", "12:", "05:00.001"],
  ["13:00:00.000", "12:59:59.999", "", "13:00:00.000"],
  ["12:04:05.500", "12:04:05.123", "12:04:05.", "500"],
  ["12:04:05.123", "12:04:05.123", "12:04:05.123", ""],
])("%s after %s keeps %j and changes %j", (time, above, same, changed) => {
  expect(timeAfter(time, line(above))).toEqual({ same, changed });
});

test("a first line is all changed", () => {
  expect(timeAfter("12:04:05.123", undefined)).toEqual({
    same: "",
    changed: "12:04:05.123",
  });
});

test("a line after a marker is all changed, as the marker shows no time to compare with", () => {
  expect(timeAfter("12:04:05.123", marker)).toEqual({
    same: "",
    changed: "12:04:05.123",
  });
});

test.each([
  ["\tat main.main()", true],
  ["    /src/cmd/main.go:42 +0x1c5", true],
  [" ", true],
  ["goroutine 1 [running]:", false],
  ['level=warn msg="db pool"', false],
  ["", false],
])("the message %j continues the line above: %s", (text, expected) => {
  expect(continues(text)).toBe(expected);
});
