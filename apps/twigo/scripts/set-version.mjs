// Stamp a single version (e.g. from the release tag) into every manifest, so
// the bundle and the in-app version never drift from the tag. Run from the repo
// root: `node apps/twigo/scripts/set-version.mjs 0.1.0-beta1`. Cargo.lock is
// refreshed by the build, so it's left alone here.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function bumpJson(content, version) {
  const data = JSON.parse(content);
  data.version = version;
  return JSON.stringify(data, null, 2) + "\n";
}

// Replace only the [package] version (the first line-anchored `version = "..."`);
// dependency `{ version = "..." }` entries are inline, so they're untouched.
export function bumpCargo(content, version) {
  return content.replace(/^version = "[^"]*"$/m, `version = "${version}"`);
}

const JSON_FILES = [
  "package.json",
  "apps/twigo/package.json",
  "apps/twigo/src-tauri/tauri.conf.json",
];
const CARGO_FILE = "apps/twigo/src-tauri/Cargo.toml";

function main(version) {
  if (!version || !SEMVER.test(version)) {
    console.error(`usage: set-version.mjs <semver>  (got "${version ?? ""}")`);
    process.exit(1);
  }
  for (const file of JSON_FILES) {
    writeFileSync(file, bumpJson(readFileSync(file, "utf8"), version));
  }
  writeFileSync(
    CARGO_FILE,
    bumpCargo(readFileSync(CARGO_FILE, "utf8"), version),
  );
  console.log(`set version to ${version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]);
}
