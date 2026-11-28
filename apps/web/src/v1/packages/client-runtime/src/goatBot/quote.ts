/** How much of a message a reply quotes. */
const QUOTE_CHARS = 200;

/**
 * A reply as sent: the person's words, then the quoted source as a Markdown quote. The words come
 * first so a task started from the reply takes its title from them, and the model still reads
 * what was quoted.
 */
export function buildGoatBotQuote(source: string, text: string): string {
  const quote = source.slice(0, QUOTE_CHARS).replace(/\r\n/g, "\n").trimEnd();
  return `${text}\n\n${quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`;
}

/** A reply's words and the source it quotes; a message ending in no quote block is all words. */
export function parseGoatBotQuote(text: string): { text: string; quote?: string } {
  const match = /^([\s\S]*?)\n\n((?:> [^\n]*(?:\n|$))+)$/.exec(text);
  if (!match || (match[1] ?? "").trim() === "") return { text };
  return {
    text: match[1] ?? "",
    quote: (match[2] ?? "")
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.slice(2))
      .join("\n"),
  };
}
