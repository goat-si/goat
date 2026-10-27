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

/** Escapes text for use as a literal inside a RegExp. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const longestFirst = (forms: Iterable<string>) =>
  [...new Set(forms)].sort((left, right) => right.length - left.length);

/** Applies one alternation of literals in batches small enough to compile. */
function replaceInBatches(
  text: string,
  forms: ReadonlyArray<string>,
  source: (alternation: string) => string,
  replacement: (match: string, ...groups: Array<string>) => string,
) {
  let result = text;
  let batch: Array<string> = [];
  let size = 0;
  const flush = () => {
    if (batch.length === 0) return;
    result = result.replace(new RegExp(source(batch.join("|")), "g"), replacement);
    batch = [];
    size = 0;
  };
  for (const form of forms) {
    const escaped = literal(form);
    if (size + escaped.length > MAX_PATTERN_SOURCE) flush();
    batch.push(escaped);
    size += escaped.length + 1;
  }
  flush();
  return result;
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
 * A text cut to a limit can end partway through a long value, and that start no longer matches
 * it. The last token's tail goes when it is the start of one.
 */
function redactCutTail(text: string, byPrefix: ReadonlyMap<string, ReadonlyArray<string>>) {
  const tail = /\S+$/u.exec(text);
  if (tail === null) return text;
  const token = tail[0];
  for (let at = 0; at + MIN_SECRET_LENGTH <= token.length; at++) {
    const rest = token.slice(at);
    const cut = byPrefix
      .get(rest.slice(0, MIN_SECRET_LENGTH))
      ?.some((form) => form.length > rest.length && form.startsWith(rest));
    if (cut === true) return text.slice(0, tail.index + at) + REDACTED;
  }
  return text;
}

/**
 * Replaces every occurrence of long literals in one scan: a pattern of their first few
 * characters finds where one may start, and the longest literal that starts there is replaced.
 */
function replaceLong(text: string, byPrefix: ReadonlyMap<string, ReadonlyArray<string>>) {
  if (byPrefix.size === 0) return text;
  const starts = [...byPrefix.keys()].map(literal);
  // Prefixes are short, so even thousands of them stay a small pattern; batch past that anyway.
  const scanners: Array<RegExp> = [];
  for (let index = 0, size = 0, from = 0; index <= starts.length; index++) {
    const next = starts[index];
    if (next === undefined || size + next.length > MAX_PATTERN_SOURCE) {
      if (index > from) scanners.push(new RegExp(starts.slice(from, index).join("|"), "g"));
      from = index;
      size = 0;
    }
    if (next !== undefined) size += next.length + 1;
  }
  let result = text;
  for (const scanner of scanners) {
    let out = "";
    let copied = 0;
    for (let match = scanner.exec(result); match !== null; match = scanner.exec(result)) {
      const at = match.index;
      const found = byPrefix.get(match[0])?.find((form) => result.startsWith(form, at));
      if (found === undefined) {
        scanner.lastIndex = at + 1;
        continue;
      }
      out += result.slice(copied, at) + REDACTED;
      copied = at + found.length;
      scanner.lastIndex = copied;
    }
    result = out + result.slice(copied);
  }
  return result;
}

/**
 * Each cookie is redacted wherever it appears as name=value, which is how an echoed Cookie or
 * Set-Cookie header looks. Its value is redacted anywhere once it has six characters, and as a
 * whole token from three; a one or two character value such as lang=en stays in ordinary text,
 * where redacting it would corrupt the page. No pattern is ever built from a whole long value.
 */
export const redactCookieValues = (
  text: string,
  cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) => {
  const valued = cookies.filter((cookie) => cookie.value !== "");
  if (valued.length === 0) return text;
  const formsOf = ({ value }: { readonly value: string }) => [value, encodeURIComponent(value)];
  // A long value goes wherever it appears, which covers name=value too.
  const byPrefix = indexByPrefix(
    valued.filter(({ value }) => value.length >= MIN_SECRET_LENGTH).flatMap(formsOf),
  );
  let result = redactCutTail(replaceLong(text, byPrefix), byPrefix);
  const short = valued.filter(({ value }) => value.length < MIN_SECRET_LENGTH);
  result = replaceInBatches(
    result,
    longestFirst(
      short
        .filter(({ name }) => name !== "")
        .flatMap(({ name, value }) => formsOf({ value }).map((form) => `${name}=${form}`)),
    ),
    (pairs) => `(^|[^\\w-])(${pairs})(?![\\w%-])`,
    (_match, before = "", pair = "") =>
      `${before}${pair.slice(0, pair.indexOf("=") + 1)}${REDACTED}`,
  );
  // A short value only as a whole token, so "ab12" never eats into "ab123" or a word.
  return replaceInBatches(
    result,
    longestFirst(short.filter(({ value }) => value.length >= MIN_TOKEN_LENGTH).flatMap(formsOf)),
    (tokens) => `(?<![A-Za-z0-9])(?:${tokens})(?![A-Za-z0-9])`,
    () => REDACTED,
  );
};
