/**
 * Live variants of a checkpoint (`?variant=ask:pick,unmarked:none`): each is a
 * choice the owner makes by looking, with the recommended one first and taken
 * where the address names none. The file goes once the choices are made, with
 * the branches of the ones that lost.
 */
const CHOICES = {
  /** How the person's own command asks what a context nobody marked is. */
  ask: ["dialog", "pick"],
  /** What the title bar's chip shows for a context nobody marked. */
  unmarked: ["chip", "none"],
} as const;

type Choices = typeof CHOICES;

export function variant<K extends keyof Choices>(name: K): Choices[K][number] {
  const named = new URLSearchParams(location.search)
    .get("variant")
    ?.split(",")
    .map((choice) => choice.split(":"))
    .find(([key]) => key === name)?.[1];
  const options: readonly string[] = CHOICES[name];
  return (options.find((option) => option === named) ??
    CHOICES[name][0]) as Choices[K][number];
}
