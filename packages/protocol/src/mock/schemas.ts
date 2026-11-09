import SCHEMAS from "./schemas.json";

/**
 * The JSON Schema that `schema_get` answers for a few kinds, recorded from
 * kind by `record_openapi`, keyed by their apiVersion and kind.
 */
const RECORDED: Readonly<Record<string, unknown>> = SCHEMAS;

/** The recorded schema of a kind as the JSON text `schema_get` answers, if there is one. */
export function recordedSchema(
  group: string,
  version: string,
  kind: string,
): string | undefined {
  const apiVersion = group === "" ? version : `${group}/${version}`;
  const schema = RECORDED[`${apiVersion}/${kind}`];
  return schema === undefined ? undefined : JSON.stringify(schema);
}
