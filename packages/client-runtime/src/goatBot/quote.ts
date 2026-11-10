export function buildGoatBotQuote(source: string, text: string): string {
  const quote = source.slice(0, 200).replace(/\r\n/g, "\n").trimEnd();
  return `${quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n${text}`;
}

export function parseGoatBotQuote(text: string): { text: string; quote?: string } {
  const match = /^((?:> [^\n]*\n)+)\n([\s\S]*)$/.exec(text);
  if (!match) return { text };
  return {
    quote: (match[1] ?? "")
      .slice(0, -1)
      .split("\n")
      .map((line) => line.slice(2))
      .join("\n"),
    text: match[2] ?? "",
  };
}
