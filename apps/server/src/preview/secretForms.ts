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
    // Only overlaps merge: occurrences that merely touch can stand apart in the original text.
    if (last !== undefined && start < last[1]) last[1] = i + 1;
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

/** What a fetch's renderer drops or rewrites: spaces, link brackets, and slashes (URLs turn \ into /). */
const ASCII_DROPPED = new Uint8Array(128);
for (const code of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x2f, 0x5b, 0x5c, 0x5d])
  ASCII_DROPPED[code] = 1;
const dropped = (code: number) =>
  code < 128 ? ASCII_DROPPED[code] === 1 : /\s/u.test(String.fromCharCode(code));

/** Skeletons shorter than this, or than half their value, would match a page's own refs and words. */
const MIN_SKELETON = 4;

const hexDigit = (code: number) =>
  code >= 0x30 && code <= 0x39
    ? code - 0x30
    : code >= 0x41 && code <= 0x46
      ? code - 0x37
      : code >= 0x61 && code <= 0x66
        ? code - 0x57
        : -1;

/** The byte the escape at `at` encodes, or -1 when there is no escape there. */
const escapedByte = (text: string, at: number) => {
  if (text.charCodeAt(at) !== 0x25) return -1;
  const high = hexDigit(text.charCodeAt(at + 1));
  const low = hexDigit(text.charCodeAt(at + 2));
  return high < 0 || low < 0 ? -1 : high * 16 + low;
};

/**
 * The character the escapes at `at` encode, as many as its UTF-8 lead byte says; undefined
 * when they do not decode, so one bad escape in a run leaves the others decoded.
 */
const decodedAt = (text: string, at: number) => {
  const lead = escapedByte(text, at);
  if (lead < 0) return undefined;
  if (lead < 0x80) return { text: String.fromCharCode(lead), length: 3 };
  const bytes = lead >= 0xf5 ? 0 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 0;
  if (bytes === 0) return undefined;
  for (let next = 1; next < bytes; next++)
    if (escapedByte(text, at + next * 3) < 0) return undefined;
  try {
    return { text: decodeURIComponent(text.slice(at, at + bytes * 3)), length: bytes * 3 };
  } catch {
    // Continuation bytes out of range, or an overlong or surrogate encoding.
    return undefined;
  }
};

interface Skeleton {
  readonly kept: string;
  readonly from: Int32Array;
  readonly to: Int32Array;
}

/**
 * The text without spaces, brackets and slashes, hex-folded, each kept code unit mapped to the
 * span it came from. Decoded, a percent escape counts as what it encodes; raw, as written, since
 * dropping a bracket can join a value's own "%" and digits into what looks like an escape.
 */
const skeleton = (text: string, decode: boolean): Skeleton => {
  // A decoded escape is never longer than its source, so the text's length bounds every array.
  const codes = new Uint16Array(text.length);
  const from = new Int32Array(text.length);
  const to = new Int32Array(text.length);
  let length = 0;
  const keep = (code: number, start: number, end: number) => {
    if (dropped(code)) return;
    codes[length] = code >= 0x41 && code <= 0x46 ? code + 0x20 : code;
    from[length] = start;
    to[length] = end;
    length++;
  };
  for (let at = 0; at < text.length;) {
    const decoded = decode && text.charCodeAt(at) === 0x25 ? decodedAt(text, at) : undefined;
    if (decoded === undefined) {
      keep(text.charCodeAt(at), at, at + 1);
      at++;
      continue;
    }
    for (let unit = 0; unit < decoded.text.length; unit++)
      keep(decoded.text.charCodeAt(unit), at, at + decoded.length);
    at += decoded.length;
  }
  let kept = "";
  for (let at = 0; at < length; at += 8_192)
    kept += String.fromCharCode(...codes.subarray(at, Math.min(length, at + 8_192)));
  return { kept, from, to };
};

export interface SkeletonForms {
  readonly raw: ReadonlyArray<SecretForm>;
  readonly decoded: ReadonlyArray<SecretForm>;
}

/** Each value's skeletons, raw and decoded, compiled once; too short a skeleton is left out. */
export const compileSkeletonForms = (values: Iterable<string>): SkeletonForms => {
  const list = [...values];
  const of = (decode: boolean) =>
    [
      ...new Set(
        list.flatMap((value) => {
          const { kept } = skeleton(value, decode);
          return kept.length >= MIN_SKELETON && kept.length * 2 >= value.length ? [kept] : [];
        }),
      ),
    ].map(compile);
  return { raw: of(false), decoded: of(true) };
};

/**
 * Spans of the text that spell a value once spaces, brackets and slashes are dropped, however
 * GOAT's renderer trimmed, collapsed or encoded them; a cut text also loses a tail that starts one.
 */
export const skeletonSpans = (text: string, forms: SkeletonForms, cut = false) => {
  if (forms.raw.length + forms.decoded.length === 0) return [];
  const raw = skeleton(text, false);
  // Without a "%" the decoded skeleton is the raw one.
  const decoded = forms.decoded.length > 0 && text.includes("%") ? skeleton(text, true) : raw;
  const spans = ({ kept, from, to }: Skeleton, compiled: ReadonlyArray<SecretForm>) =>
    compiled.flatMap((form) =>
      spansOf(kept, form, cut).map(([start, end]): [number, number] => [
        from[start] ?? 0,
        end >= kept.length ? text.length : (to[end - 1] ?? text.length),
      ]),
    );
  return [...spans(raw, forms.raw), ...spans(decoded, forms.decoded)];
};

/** The longest compiled form, for callers that cut text to a limit and need room past it. */
export const longestForm = (...lists: ReadonlyArray<ReadonlyArray<SecretForm>>) =>
  Math.max(0, ...lists.flat().map((form) => form.text.length));
