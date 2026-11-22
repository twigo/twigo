import type { Fact, Hidden, OpenedIssue } from "@twigo/protocol";

/** GitHub's private reporting of a vulnerability, which SECURITY.md names for what is not to be public. */
export const SECURITY_URL =
  "https://github.com/twigo/twigo/security/advisories/new";

function listed(items: readonly string[]): string {
  const last = items[items.length - 1] ?? "";
  return items.length < 2
    ? last
    : `${items.slice(0, -1).join(", ")} and ${last}`;
}

export function hiddenWords({
  names,
  paths,
  tokens,
  addresses,
  quoted,
  lines,
}: Hidden): string {
  const parts = [
    { count: names, one: "name", many: "names" },
    { count: paths, one: "path", many: "paths" },
    { count: tokens, one: "token", many: "tokens" },
    { count: addresses, one: "address", many: "addresses" },
    { count: quoted, one: "quoted string", many: "quoted strings" },
    {
      count: lines,
      one: "line that is not a record",
      many: "lines that are not records",
    },
  ]
    .filter(({ count }) => count > 0)
    .map(
      ({ count, one, many }) => `${String(count)} ${count === 1 ? one : many}`,
    );
  return parts.length === 0
    ? "Twigo found nothing to hide; read it before you paste."
    : `Twigo hid ${listed(parts)}; read it before you paste.`;
}

/** The text the report is saved and copied as: the facts it states, what the person wrote of it, then the log. */
export function reportText({
  facts,
  title = "",
  description = "",
  log,
}: {
  facts: readonly Fact[];
  title?: string;
  description?: string;
  log: string;
}): string {
  return [
    facts.map(({ label, value }) => `${label}: ${value}`).join("\n"),
    [title.trim(), description.trim()].filter((part) => part !== "").join("\n"),
    log,
  ]
    .filter((block) => block !== "")
    .join("\n\n");
}

export function openedWords(
  { factsCut, descriptionCut }: OpenedIssue,
  facts: readonly Fact[],
): string {
  const cut = [
    ...factsCut.map(
      (id) => `shortened ${facts.find((fact) => fact.id === id)?.label ?? id}`,
    ),
    ...(descriptionCut ? ["cut your description"] : []),
  ];
  const said = "The log is on your clipboard: paste it into Logs.";
  return cut.length === 0
    ? said
    : `${said} The link was too long, so Twigo ${listed(cut)}.`;
}
