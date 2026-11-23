/**
 * A release's status word where its column may narrow: its head, up to the
 * last `-`, gives way first and its tail stays whole, so `pending-install`,
 * `pending-upgrade` and `pending-rollback` stay told apart, with the whole
 * word in its tooltip.
 * `CutInTheMiddle` leaves these words whole at any floor it can take: their
 * middle is under the 2em its track keeps.
 */
export function CutWord({ text }: { text: string }) {
  const at = text.lastIndexOf("-") + 1;
  if (at === 0) return text;
  return (
    <span title={text} className="flex min-w-0">
      <span className="min-w-[2em] truncate">{text.slice(0, at)}</span>
      <span className="shrink-0">{text.slice(at)}</span>
    </span>
  );
}
