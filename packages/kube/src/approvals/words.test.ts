import { expect, test } from "vitest";
import type { NoDiff } from "@twigo/protocol";
import {
  commandLine,
  inputWords,
  noDiffWords,
  propagationWords,
} from "./words";

test("a command line quotes the words a shell would split or expand, and leaves plain ones", () => {
  expect(
    commandLine(["sh", "-c", "tail -n 100 /var/log/app.log | grep ERROR"]),
  ).toBe("sh -c 'tail -n 100 /var/log/app.log | grep ERROR'");
  expect(commandLine(["echo", "it's", "$HOME", ""])).toBe(
    "echo 'it'\\''s' '$HOME' ''",
  );
  expect(commandLine(["ls", "-l", "/tmp/a_b-c.d"])).toBe("ls -l /tmp/a_b-c.d");
});

test("every reason a write has no diff is told in a sentence a person reads", () => {
  const reasons: NoDiff[] = [
    { reason: "subresource" },
    { reason: "aggregated" },
    { reason: "unverified" },
    { reason: "refused", message: 'admission webhook "x" refused it' },
    { reason: "notAResource" },
  ];
  const told = reasons.map((reason) => noDiffWords(reason));
  expect(told.map((sentences) => sentences.length)).toEqual([1, 1, 1, 2, 1]);
  expect(new Set(told.flat()).size).toBe(6);
  expect(told[3]?.[0]).toContain('admission webhook "x" refused it');
});

test("a delete says what happens to the dependents by the propagation it asks for", () => {
  const told = [null, "Foreground", "Background", "Orphan", "Other"].map(
    propagationWords,
  );
  expect(new Set(told).size).toBe(5);
  expect(told[0]).toContain("no propagation");
  expect(told[1]).toContain("block its deletion");
  expect(told[4]).toContain("Other");
});

test("a session says what reaches its process", () => {
  expect(inputWords(false, false)).toBe("None: it only shows output.");
  expect(inputWords(true, true)).toBe("What is typed, in a terminal.");
  expect(inputWords(false, true)).toBe(
    "What the client sends, with no terminal.",
  );
});
