import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";
import { expect, test } from "vitest";

const UNSCANNED_MONO = ["--font", "mono"].join("-");

const family = (text: string | undefined) => text?.replace(/\s+/g, " ").trim();
const declaration = (css: string) =>
  family(new RegExp(`${UNSCANNED_MONO}:([^;}]+)[;}]`).exec(css)?.[1]);

test("the production CSS defines the app's mono family on :root, where the terminal reads it", async () => {
  const built = await build({
    root: join(import.meta.dirname, ".."),
    mode: "production",
    logLevel: "silent",
    build: { write: false },
  });
  const css = (Array.isArray(built) ? built : [built])
    .flatMap((result) => ("output" in result ? result.output : []))
    .flatMap((file) =>
      file.type === "asset" && file.fileName.endsWith(".css")
        ? [String(file.source)]
        : [],
    )
    .join("\n");
  const theme = readFileSync(
    join(import.meta.dirname, "../../../packages/ui/src/styles/theme.css"),
    "utf8",
  );
  expect(declaration(theme)).toContain("JetBrains Mono");
  expect(declaration(css)).toBe(declaration(theme));
}, 60_000);
