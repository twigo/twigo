import { lazy, Suspense, useMemo } from "react";
import { stringify } from "yaml";
import { Skeleton } from "@twigo/ui";

const YamlView = lazy(() => import("./YamlView"));

/** The object as YAML, from the JSON Rust sends without managedFields or a Secret's values. */
export function Manifest({ json }: { json: string }) {
  const text = useMemo(() => stringify(JSON.parse(json)), [json]);
  return (
    <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
      <YamlView text={text} />
    </Suspense>
  );
}
