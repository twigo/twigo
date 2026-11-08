import { lazy, Suspense, useMemo } from "react";
import { stringify } from "yaml";
import { Skeleton } from "@twigo/ui";

const YamlEditor = lazy(() => import("./YamlEditor"));

/**
 * The object as YAML, from the JSON Rust sends without managedFields or a
 * Secret's values. YAML 1.1, which kubectl reads, quotes strings such as
 * `"yes"` and `"on"` that it would read as booleans.
 */
export function yamlOf(json: string): string {
  return stringify(JSON.parse(json), { version: "1.1" });
}

/** The YAML tab: read-only Monaco, loaded on first use. */
export function Manifest({ json }: { json: string }) {
  const text = useMemo(() => yamlOf(json), [json]);
  return (
    <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
      <YamlEditor text={text} />
    </Suspense>
  );
}
