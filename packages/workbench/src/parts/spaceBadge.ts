/** Two letters for a space: the first of its first two words, or its first two. */
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const [first = "", second] = words;
  return (
    second ? `${first.charAt(0)}${second.charAt(0)}` : first.slice(0, 2)
  ).toUpperCase();
}
