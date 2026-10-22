/** A run of bot text: plain words, or a web address to open. */
export type GoatBotTextPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly url: string };

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gu;
/** Sentence punctuation that ends a sentence, not the address before it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"。、]+$/u;

/** Drops a closing bracket the address never opened, as in "(see https://x.dev/a)". */
function trimUnbalanced(url: string, close: string, open: string): string {
  let result = url;
  while (result.endsWith(close) && result.split(open).length < result.split(close).length) {
    result = result.slice(0, -1);
  }
  return result;
}

function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const next = trimUnbalanced(
      trimUnbalanced(url.replace(TRAILING_PUNCTUATION, ""), ")", "("),
      "]",
      "[",
    );
    if (next === url) return url;
    url = next;
  }
}

/** Splits bot text into plain runs and http(s) links, keeping every character in order. */
export function splitGoatBotTextLinks(text: string): ReadonlyArray<GoatBotTextPart> {
  const parts: Array<GoatBotTextPart> = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (!URL.canParse(url)) continue;
    const start = match.index;
    if (start > cursor) parts.push({ kind: "text", text: text.slice(cursor, start) });
    parts.push({ kind: "link", text: url, url });
    cursor = start + url.length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}
