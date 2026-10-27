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

/** Escapes text for use as a literal inside a RegExp. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Literal alternatives, longest first, so a value containing another is replaced whole. */
const alternatives = (forms: Iterable<string>) =>
  [...new Set(forms)]
    .sort((left, right) => right.length - left.length)
    .map(literal)
    .join("|");

/**
 * Each cookie is redacted wherever it appears as name=value, which is how an echoed Cookie or
 * Set-Cookie header looks. Its value is redacted anywhere once it has six characters, and as a
 * whole token from three; a one or two character value such as lang=en stays in ordinary text,
 * where redacting it would corrupt the page. Each kind is one pass, however many cookies there are.
 */
export const redactCookieValues = (
  text: string,
  cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) => {
  const named = cookies.filter((cookie) => cookie.name !== "" && cookie.value !== "");
  if (named.length === 0) return text;
  const pairs = alternatives(
    named.flatMap(({ name, value }) => [
      `${name}=${value}`,
      `${name}=${encodeURIComponent(value)}`,
    ]),
  );
  let result = text.replace(
    new RegExp(`(^|[^\\w-])(${pairs})(?![\\w%-])`, "g"),
    (_match, before: string, pair: string) =>
      `${before}${pair.slice(0, pair.indexOf("=") + 1)}${REDACTED}`,
  );
  const forms = (min: number, max: number) =>
    named
      .filter(({ value }) => value.length >= min && value.length < max)
      .flatMap(({ value }) => [value, encodeURIComponent(value)]);
  const long = forms(MIN_SECRET_LENGTH, Number.POSITIVE_INFINITY);
  if (long.length > 0) result = result.replace(new RegExp(alternatives(long), "g"), REDACTED);
  const short = forms(MIN_TOKEN_LENGTH, MIN_SECRET_LENGTH);
  // A short value only as a whole token, so "ab12" never eats into "ab123" or a word.
  if (short.length > 0)
    result = result.replace(
      new RegExp(`(?<![A-Za-z0-9])(?:${alternatives(short)})(?![A-Za-z0-9])`, "g"),
      REDACTED,
    );
  return result;
};
