/**
 * Redacts the values of cookies a tab holds wherever they appear in text bound for an agent. Only
 * the values themselves go, so ordinary page text that merely looks like a token stays.
 *
 * @module cookieValues
 */

export const REDACTED = "[redacted]";
/** Cookie values this long are redacted wherever they appear, even inside other text. */
const MIN_SECRET_LENGTH = 6;
/**
 * Shorter values down to this length are redacted as whole tokens. One or two characters cannot
 * hold a credential and match everywhere, so those are redacted only as name=value.
 */
const MIN_TOKEN_LENGTH = 3;

/** Escapes text for use as a literal inside a RegExp. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Each cookie is redacted wherever it appears as name=value, which is how an echoed Cookie or
 * Set-Cookie header looks. Its value is redacted anywhere once it has six characters, and as a
 * whole token from three; a one or two character value such as lang=en stays in ordinary text,
 * where redacting it would corrupt the page.
 */
export const redactCookieValues = (
  text: string,
  cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) => {
  let result = text;
  for (const { name, value } of cookies) {
    if (!name || !value) continue;
    result = result.replace(
      new RegExp(
        `(^|[^\\w-])(${literal(name)})=(${literal(value)}|${literal(encodeURIComponent(value))})(?![\\w%-])`,
        "g",
      ),
      `$1$2=${REDACTED}`,
    );
  }
  // Longest first, so a value containing another is replaced whole.
  const values = [...new Set(cookies.map((cookie) => cookie.value))]
    .filter((value) => value.length >= MIN_TOKEN_LENGTH)
    .toSorted((left, right) => right.length - left.length);
  for (const value of values) {
    for (const form of new Set([value, encodeURIComponent(value)])) {
      result =
        value.length >= MIN_SECRET_LENGTH
          ? result.replaceAll(form, REDACTED)
          : // A short value only as a whole token, so "ab12" never eats into "ab123" or a word.
            result.replace(
              new RegExp(`(?<![A-Za-z0-9])${literal(form)}(?![A-Za-z0-9])`, "g"),
              REDACTED,
            );
    }
  }
  return result;
};
