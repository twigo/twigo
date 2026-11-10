/**
 * @todo: delete this file, and the branches in `ApprovalHost.tsx` that read it, once the owner has chosen between the variants of the checkpoint.
 *
 * `?variant=diff:collapsed,scope:checkbox` in the URL of the mock picks how the dialog of an ask looks:
 * `diff:inline` (the default) shows the diff in the dialog, which widens for it, and `diff:collapsed` keeps the dialog at its usual width behind "Show changes";
 * `scope:buttons` (the default) offers Allow once and Allow for 15 minutes side by side, and `scope:checkbox` offers Allow with "Don't ask again for 15 minutes" above.
 */
export interface Variant {
  readonly diff: "inline" | "collapsed";
  readonly scope: "buttons" | "checkbox";
}

export function variant(): Variant {
  const asked = new Set(
    (new URLSearchParams(globalThis.location.search).get("variant") ?? "")
      .split(",")
      .map((part) => part.trim()),
  );
  return {
    diff: asked.has("diff:collapsed") ? "collapsed" : "inline",
    scope: asked.has("scope:checkbox") ? "checkbox" : "buttons",
  };
}
