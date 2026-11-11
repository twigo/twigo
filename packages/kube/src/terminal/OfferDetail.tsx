import type { OfferEntry, OfferWords } from "./offerWords";

function Names({
  label,
  entries,
}: {
  label: string;
  entries: readonly OfferEntry[];
}) {
  return (
    <div className="grid gap-0.5">
      <span className="text-muted-foreground">{label}</span>
      {entries.map(({ name, kinds }) => (
        <span key={name} className="grid">
          <code className="font-mono text-[11px] wrap-anywhere select-text">
            {name}
          </code>
          <span className="text-[11px] text-muted-foreground">
            {kinds.join(", ")}
          </span>
        </span>
      ))}
    </div>
  );
}

/** What came and what a move leaves out, by name. */
export function OfferDetail({ words }: { words: OfferWords }) {
  return (
    <div className="grid gap-1.5">
      {words.moves.length > 0 && (
        <Names label="A move writes" entries={words.moves} />
      )}
      {words.leaves.length > 0 && (
        <Names
          label="A move leaves out, since your files have them"
          entries={words.leaves}
        />
      )}
    </div>
  );
}
