/**
 * An object's name in the parts that tell it from its siblings: what came
 * before what the API server generated, the hash, and the last segment of
 * the generated part, after its last `-`, which is all of it when it has
 * none. `generated` is where the generated part starts (`Row.generated`).
 */
export function splitName(name: string, generated: number | null) {
  if (generated === null) {
    return { first: name, hash: "", last: "" };
  }
  const rest = name.slice(generated);
  const dash = rest.lastIndexOf("-") + 1;
  return {
    first: name.slice(0, generated),
    hash: rest.slice(0, dash),
    last: rest.slice(dash),
  };
}
