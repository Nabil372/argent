/**
 * How a flow report prints device text it may cut. The CLI prints the text a
 * step found on its `actual:` line, cut here. The MCP client prints the whole
 * found text, as its result holds no report.
 */

const MAX_PRINTED_CHARS = 300;

/**
 * `text` passed through `print`, cut to its first 300 characters. The count of
 * the rest follows outside what `print` returns, so the cut never reads as
 * device text. Counted in code points, so the cut never splits a surrogate
 * pair.
 */
export function printCapped(text: string, print: (text: string) => string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_PRINTED_CHARS) return print(text);
  const rest = (chars.length - MAX_PRINTED_CHARS).toLocaleString("en-US");
  return `${print(chars.slice(0, MAX_PRINTED_CHARS).join(""))} … (${rest} more characters)`;
}
