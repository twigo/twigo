/**
 * Variants the owner chooses between at the checkpoint, read from the page's
 * URL: `?variant=pick:live,crumb:list`, a group and the variant it takes,
 * comma-separated. Without one a group has its default.
 *
 * @todo: remove the variants the owner did not choose once he has chosen at the checkpoint
 */
export function variant(group: string): string | undefined {
  const asked = new URLSearchParams(globalThis.location.search).get("variant");
  return asked
    ?.split(",")
    .map((each) => each.split(":"))
    .find(([name]) => name === group)?.[1];
}
