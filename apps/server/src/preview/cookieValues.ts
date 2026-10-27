/**
 * Redacts the values of cookies a tab holds wherever they appear in text bound for an agent. Only
 * the values themselves go, so ordinary page text that merely looks like a token stays.
 *
 * @module cookieValues
 */

export const REDACTED = "[redacted]";
/** Cookie values this long are redacted wherever they appear, even inside other text. */
export const MIN_SECRET_LENGTH = 6;
/**
 * Shorter values down to this length are redacted as whole tokens. One or two characters cannot
 * hold a credential and match everywhere, so those are redacted only as name=value.
 */
const MIN_TOKEN_LENGTH = 3;
/** Pattern source per compiled RegExp; a page can hold thousands of cookies of up to 4 KiB. */
const MAX_PATTERN_SOURCE = 32_768;

type Span = readonly [number, number];

/** Escapes text for use as a literal inside a RegExp. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const longestFirst = (forms: Iterable<string>) =>
  [...new Set(forms)].sort((left, right) => right.length - left.length);

/** Runs an alternation of literals over the text in batches small enough to compile. */
function matchInBatches(
  text: string,
  forms: ReadonlyArray<string>,
  source: (alternation: string) => string,
  span: (match: RegExpExecArray) => Span,
) {
  const spans: Array<Span> = [];
  const run = (batch: ReadonlyArray<string>) => {
    if (batch.length === 0) return;
    const pattern = new RegExp(source(batch.join("|")), "g");
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      spans.push(span(match));
      if (match[0] === "") pattern.lastIndex++;
    }
  };
  let batch: Array<string> = [];
  let size = 0;
  for (const form of forms) {
    const escaped = literal(form);
    if (size + escaped.length > MAX_PATTERN_SOURCE) {
      run(batch);
      batch = [];
      size = 0;
    }
    batch.push(escaped);
    size += escaped.length + 1;
  }
  run(batch);
  return spans;
}

/** Long literals grouped by their first characters, longest first within each group. */
function indexByPrefix(forms: ReadonlyArray<string>) {
  const byPrefix = new Map<string, Array<string>>();
  for (const form of longestFirst(forms)) {
    const prefix = form.slice(0, MIN_SECRET_LENGTH);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), form]);
  }
  return byPrefix;
}

/**
 * Long literals in one left-to-right pass: at each position the longest one that starts there,
 * then on past its end. No pattern is built from a whole value, and no offset is read twice.
 */
function longSpans(text: string, byPrefix: ReadonlyMap<string, ReadonlyArray<string>>) {
  const spans: Array<Span> = [];
  for (let at = 0; at + MIN_SECRET_LENGTH <= text.length;) {
    const found = byPrefix
      .get(text.slice(at, at + MIN_SECRET_LENGTH))
      ?.find((form) => text.startsWith(form, at));
    if (found === undefined) at++;
    else {
      spans.push([at, at + found.length]);
      at += found.length;
    }
  }
  return spans;
}

/**
 * A text cut to a limit can end partway through a long value, and that start no longer matches
 * it. The last token's tail goes when it is the start of one.
 */
function cutTailSpan(text: string, byPrefix: ReadonlyMap<string, ReadonlyArray<string>>) {
  const tail = /\S+$/u.exec(text);
  if (tail === null) return [];
  const token = tail[0];
  for (let at = 0; at + MIN_SECRET_LENGTH <= token.length; at++) {
    const rest = token.slice(at);
    const cut = byPrefix
      .get(rest.slice(0, MIN_SECRET_LENGTH))
      ?.some((form) => form.length > rest.length && form.startsWith(rest));
    if (cut === true) return [[tail.index + at, text.length] as const];
  }
  return [];
}

/** The text with the spans, merged where they touch or overlap, replaced by REDACTED. */
function replaceSpans(text: string, spans: ReadonlyArray<Span>) {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((left, right) => left[0] - right[0]);
  let result = "";
  let [from, to] = sorted[0] ?? [0, 0];
  let copied = 0;
  for (const [start, end] of sorted.slice(1)) {
    if (start <= to) {
      to = Math.max(to, end);
      continue;
    }
    result += text.slice(copied, from) + REDACTED;
    copied = to;
    [from, to] = [start, end];
  }
  return result + text.slice(copied, from) + REDACTED + text.slice(to);
}

/**
 * Each cookie is redacted wherever it appears as name=value, which is how an echoed Cookie or
 * Set-Cookie header looks. Its value is redacted anywhere once it has six characters, and as a
 * whole token from three. Every kind of match is found in the original text and only then
 * replaced, so one never hides another; no pattern is ever built from a whole long value.
 */
export const redactCookieValues = (
  text: string,
  cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) => {
  const valued = cookies.filter((cookie) => cookie.value !== "");
  if (valued.length === 0) return text;
  // As sent, as a URL encodes it, and as JSON escapes it inside a string.
  const formsOf = (value: string) => [
    value,
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ];
  const byPrefix = indexByPrefix(
    valued
      .filter(({ value }) => value.length >= MIN_SECRET_LENGTH)
      .flatMap(({ value }) => formsOf(value)),
  );
  const short = valued.filter(({ value }) => value.length < MIN_SECRET_LENGTH);
  const pairs = matchInBatches(
    text,
    longestFirst(
      short
        .filter(({ name }) => name !== "")
        .flatMap(({ name, value }) => formsOf(value).map((form) => `${name}=${form}`)),
    ),
    (alternation) => `(?<![\\w-])(?:${alternation})(?![\\w%-])`,
    (match): Span => [match.index + match[0].indexOf("=") + 1, match.index + match[0].length],
  );
  // A short value only as a whole token, so "ab12" never eats into "ab123" or a word.
  const tokens = matchInBatches(
    text,
    longestFirst(
      short
        .filter(({ value }) => value.length >= MIN_TOKEN_LENGTH)
        .flatMap(({ value }) => formsOf(value)),
    ),
    (alternation) => `(?<![A-Za-z0-9])(?:${alternation})(?![A-Za-z0-9])`,
    (match): Span => [match.index, match.index + match[0].length],
  );
  return replaceSpans(text, [
    ...longSpans(text, byPrefix),
    ...cutTailSpan(text, byPrefix),
    ...pairs,
    ...tokens,
  ]);
};
