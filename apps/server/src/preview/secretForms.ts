/**
 * Where a secret GOAT filled shows in text: every form a page or a snapshot writes it in, found
 * as a substring wherever it stands, overlaps included, in time linear in the text.
 *
 * @module secretForms
 */

/** How Playwright's snapshot quotes text: JSON's escapes, and \xNN for the unnamed controls. */
export const playwrightQuoted = (value: string) =>
  value.replace(/[\\"\p{Cc}]/gu, (char) =>
    '\\"\b\f\n\r\t'.includes(char)
      ? JSON.stringify(char).slice(1, -1)
      : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

const uriEncoded = (value: string) => {
  try {
    return [encodeURIComponent(value)];
  } catch {
    // An unpaired surrogate has no URL form for a page to echo.
    return [];
  }
};

/** How a page or a snapshot can write the value back: raw, JSON-escaped, URL- or form-encoded. */
const encodedForms = (value: string) =>
  // The snapshot drops zero-width characters and collapses whitespace; a fetch only collapses it.
  [
    value,
    value
      .replace(/[\u200b\u00ad]/g, "")
      .trim()
      .replace(/\s+/g, " "),
    value.replace(/\s+/g, " ").trim(),
  ]
    .flatMap((each) => [
      each,
      JSON.stringify(each).slice(1, -1),
      playwrightQuoted(each),
      ...uriEncoded(each),
      new URLSearchParams({ v: each }).toString().slice(2),
    ])
    .flatMap((form) => [form, form.replaceAll("'", "''")]);

/**
 * Servers write percent escapes in either case. Folding every A-F, wherever it stands, keeps each
 * index in place and every exact match a match; it only also masks hex-case variants.
 */
const foldHex = (text: string) => text.replace(/[A-F]/g, (digit) => digit.toLowerCase());

export interface SecretForm {
  readonly text: string;
  readonly fallback: Int32Array;
}

/** The Knuth-Morris-Pratt table, built once per form for every string one answer holds. */
const compile = (form: string): SecretForm => {
  const fallback = new Int32Array(form.length);
  for (let i = 1, k = 0; i < form.length; i++) {
    while (k > 0 && form.charCodeAt(i) !== form.charCodeAt(k)) k = fallback[k - 1] ?? 0;
    if (form.charCodeAt(i) === form.charCodeAt(k)) k++;
    fallback[i] = k;
  }
  return { text: form, fallback };
};

/**
 * Where `form` occurs in `text`, overlaps included, merged into spans. Knuth-Morris-Pratt keeps
 * this linear, so a long or repetitive secret neither builds a huge pattern nor stalls the loop.
 */
const spansOf = (text: string, { text: form, fallback }: SecretForm, cut: boolean) => {
  const spans: Array<[number, number]> = [];
  if (form.length > text.length && !cut) return spans;
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    while (k > 0 && text.charCodeAt(i) !== form.charCodeAt(k)) k = fallback[k - 1] ?? 0;
    if (text.charCodeAt(i) === form.charCodeAt(k)) k++;
    if (k < form.length) continue;
    const start = i + 1 - k;
    const last = spans.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = i + 1;
    else spans.push([start, i + 1]);
    k = fallback[k - 1] ?? 0;
  }
  // A cut text can end partway through the value: a tail that starts it goes too.
  if (cut && k > 0) spans.push([text.length - k, text.length]);
  return spans;
};

/** Compiles every form of every value once, for all the strings one answer or list holds. */
export const compileSecretForms = (values: Iterable<string>) =>
  [...new Set([...values].flatMap(encodedForms).map(foldHex))]
    .filter((form) => form !== "")
    .map(compile);

/** Every span a form covers in the original text; a cut text also loses a tail that starts one. */
export const secretSpans = (text: string, forms: ReadonlyArray<SecretForm>, cut = false) => {
  if (forms.length === 0) return [];
  const searched = foldHex(text);
  return forms.flatMap((form) => spansOf(searched, form, cut));
};
