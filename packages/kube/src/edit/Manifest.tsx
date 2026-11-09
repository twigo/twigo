import { lazy, Suspense, useId, useMemo } from "react";
import { Skeleton } from "@twigo/ui";
import { yamlOfJson } from "./object";

const YamlEditor = lazy(() => import("./YamlEditor"));

export function Manifest({ json }: { json: string }) {
  const uri = useId();
  const text = useMemo(() => yamlOfJson(json), [json]);
  return (
    <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
      <YamlEditor uri={`details:${uri}`} text={text} readOnly />
    </Suspense>
  );
}
