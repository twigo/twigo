const NUMBER = String.raw`\d+(?:\.\d+)?`;
const IPV4 = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;
const FIGURES = new RegExp(
  String.raw`^(?:${NUMBER} ?[A-Za-z]{0,2}(?: \(${NUMBER}%\))?|\d+/\d+|(?:\d+[smhdy])+)$`,
);
const ADDRESSES = new RegExp(String.raw`^${IPV4}(?:, ?${IPV4})*$`);

/**
 * Whether text is a count, a quantity with or without its share (`970m (6%)`),
 * a ratio (`2/2`) or a duration as kubectl prints it (`48s`, `2m6s`).
 */
export function isFigures(text: string): boolean {
  return FIGURES.test(text);
}

/** Whether text lines up in tabular numerals: figures, an IPv4 address or a list of them. */
export function isTabular(text: string): boolean {
  return isFigures(text) || ADDRESSES.test(text);
}
