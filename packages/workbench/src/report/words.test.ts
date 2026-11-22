import { expect, test } from "vitest";
import type { Fact } from "@twigo/protocol";
import { hiddenWords, openedWords, reportText } from "./words";

const NONE = {
  names: 0,
  paths: 0,
  tokens: 0,
  addresses: 0,
  quoted: 0,
  lines: 0,
};

test("what the redaction hid is counted in the person's words, singular where it is one, and nothing is said of what it did not hide", () => {
  expect(hiddenWords({ ...NONE, names: 6, paths: 2, tokens: 1 })).toBe(
    "Twigo hid 6 names, 2 paths and 1 token; read it before you paste.",
  );
  expect(hiddenWords({ ...NONE, quoted: 1 })).toBe(
    "Twigo hid 1 quoted string; read it before you paste.",
  );
  expect(hiddenWords({ ...NONE, lines: 2 })).toBe(
    "Twigo hid 2 lines that are not records; read it before you paste.",
  );
  expect(hiddenWords(NONE)).toBe(
    "Twigo found nothing to hide; read it before you paste.",
  );
});

const FACTS: Fact[] = [
  { id: "twigo", label: "Twigo", value: "0.1.0", optional: false },
  { id: "kubernetes", label: "Kubernetes", value: "v1.37.2", optional: true },
];

test("the report's text is the facts and the log, each block apart and none empty", () => {
  expect(reportText({ facts: FACTS, log: "line" })).toBe(
    "Twigo: 0.1.0\nKubernetes: v1.37.2\n\nline",
  );
  expect(reportText({ facts: [], log: "line" })).toBe("line");
  expect(reportText({ facts: [], log: "" })).toBe("");
});

test("the toast says where to paste the log, and what the link had to leave short", () => {
  expect(openedWords({ factsCut: [] }, FACTS)).toBe(
    "The log is on your clipboard: paste it into Logs.",
  );
  expect(openedWords({ factsCut: ["kubernetes"] }, FACTS)).toBe(
    "The log is on your clipboard: paste it into Logs. The link was too long, so Twigo shortened Kubernetes.",
  );
});
