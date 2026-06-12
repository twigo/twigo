// Case-insensitive substring match of a message against a filter, over its
// subject or payload preview. An empty filter matches everything. Shared by the
// live stream and the JetStream message browser so they filter identically.
export function messageMatches(
  subject: string,
  preview: string,
  filter: string,
): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return subject.toLowerCase().includes(f) || preview.toLowerCase().includes(f);
}
