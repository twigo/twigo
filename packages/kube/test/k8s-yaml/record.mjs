// Runs the recorder: writes the values of values.ts with our writer, has Go
// read each text back, and rewrites read.json and written.json beside it.
// `node record.mjs`; it needs go and a Node that runs TypeScript, and calls no cluster.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { yamlOfObject } from "../../src/edit/object.ts";
import { awkward, COUNT, generated, SEED } from "./values.ts";

const directory = mkdtempSync(join(tmpdir(), "k8s-yaml-"));
try {
  const written = [...awkward(), ...generated(SEED, COUNT)].map((value) => ({
    text: yamlOfObject(value),
    want: JSON.stringify(value),
  }));
  const path = join(directory, "written.json");
  writeFileSync(path, JSON.stringify(written));
  execFileSync("go", ["run", ".", path], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    stdio: "inherit",
  });
} finally {
  rmSync(directory, { recursive: true });
}
