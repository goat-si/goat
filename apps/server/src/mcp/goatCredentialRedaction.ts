import { legacyEnvName } from "@goat/contracts/legacyT3Names";

/**
 * GOAT gives each agent a thread-scoped MCP bearer token in its shell environment
 * (GOAT_ACP_MCP_AUTHORIZATION for the goat CLI, the ACP bridge and the Computer Use lease proxy;
 * GOAT_MCP_BEARER_TOKEN for Pi), so an agent that dumps its environment prints it. Agent output is
 * persisted, shown in every client and synced to remote viewers, so the token is scrubbed before
 * it gets there (#1201).
 *
 * Every token McpSessionRegistry mints starts with its per-run tag, which finds the token in any
 * form. The variable names and the "Bearer" shape cover tokens this process did not mint.
 */

export const REDACTED_CREDENTIAL = "[redacted]";

const TOKEN_CHAR = "[A-Za-z0-9_-]";
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;
// An 8 character run tag plus a 43 character secret; builds before the tag minted the bare secret.
const TOKEN_LENGTH = 51;
const REGISTRY_TOKEN = `${TOKEN_CHAR}{43}(?:${TOKEN_CHAR}{8})?(?!${TOKEN_CHAR})`;

// Every variable GOAT puts a thread's MCP credential in, with the spelling older builds read.
const CREDENTIAL_NAMES: ReadonlyArray<string> = [
  "GOAT_ACP_MCP_AUTHORIZATION",
  "GOAT_MCP_AUTHORIZATION",
  "GOAT_MCP_BEARER_TOKEN",
  "GOAT_CUA_LEASE_AUTHORIZATION",
].flatMap((name) => [name, legacyEnvName(name) ?? name]);
const CREDENTIAL_NAME = `(?:${CREDENTIAL_NAMES.join("|")})`;
// env, export -p, JSON (escaped too): the name, an optional quote, = or :, an optional quote.
const ASSIGNMENT = String.raw`\\?["']?[ \t]{0,8}[=:][ \t]{0,8}\\?["']?`;
// "Bearer " including a shell-escaped space.
const BEARER = String.raw`Bearer(?:\\?[ \t]){1,8}`;
// A value ends at whitespace, a quote, a backslash, a separator, or env -0's NUL.
const VALUE_CHAR = String.raw`[^\s"'\\,;\0]`;
// Longest value redacted as one. Real tokens are 43 or 51 characters; the bound keeps streamed
// and whole-text redaction equal, since a stream can hold back only so much.
const MAX_VALUE = 256;

const NAMED_VALUE = `(${CREDENTIAL_NAME}${ASSIGNMENT}(?:${BEARER})?)${VALUE_CHAR}{1,${MAX_VALUE}}`;
const BEARER_VALUE = `(?<![A-Za-z0-9])(${BEARER})${REGISTRY_TOKEN}`;

/** Run tags of the registries in this process; tests make many, production one. */
const runTags: Array<string> = [];
const MAX_RUN_TAGS = 32;
/**
 * Every credential in one pass, so a stream's held-back tail and whole-text redaction see the same
 * matches: a labelled value keeps its label (group 1 or 2), a tagged run goes whole.
 */
let credential = buildCredential();
let partialCredential = buildPartialCredential();

/** Called by McpSessionRegistry with the tag that starts every token it mints. */
export function registerCredentialRunTag(tag: string): void {
  if (!TOKEN_CHARS.test(tag) || runTags.includes(tag)) return;
  runTags.push(tag);
  if (runTags.length > MAX_RUN_TAGS) runTags.shift();
  credential = buildCredential();
  partialCredential = buildPartialCredential();
}

function buildCredential(): RegExp {
  const tagged =
    runTags.length === 0 ? [] : [`(?:${runTags.join("|")})${TOKEN_CHAR}{0,${MAX_VALUE}}`];
  return new RegExp([NAMED_VALUE, BEARER_VALUE, ...tagged].join("|"), "gi");
}

/** Text with every GOAT MCP credential replaced by {@link REDACTED_CREDENTIAL}. */
export function redactGoatCredentials(text: string): string {
  return redactBefore(text, text.length, Array.from(text.matchAll(credential)));
}

/**
 * The redacted text before end. The matches come from the whole text, so a pattern that looks past
 * end (a token must not run on) sees what really follows.
 */
function redactBefore(text: string, end: number, matches: ReadonlyArray<RegExpExecArray>): string {
  let redacted = "";
  let shown = 0;
  for (const match of matches) {
    if (match.index >= end) break;
    const label: string = match[1] ?? match[2] ?? "";
    redacted += text.slice(shown, match.index) + label + REDACTED_CREDENTIAL;
    // partialStart never cuts inside a credential; should one reach past end, hide all of it.
    shown = Math.min(match.index + match[0].length, end);
  }
  return redacted + text.slice(shown, end);
}

const MAX_DEPTH = 32;

/** {@link redactGoatCredentials} over every string in a plain value; unchanged parts keep identity. */
export function redactGoatCredentialsDeep<T>(value: T): T {
  return redactValue(value, 0) as T;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactGoatCredentials(value);
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    let next: Array<unknown> | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const redacted = redactValue(value[index], depth + 1);
      if (redacted !== value[index]) {
        next ??= value.slice();
        next[index] = redacted;
      }
    }
    return next ?? value;
  }
  // Dates and other class instances carry no agent text.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let next: Record<string, unknown> | undefined;
  for (const [key, entry] of Object.entries(value)) {
    const redacted = redactValue(entry, depth + 1);
    if (redacted !== entry) {
      next ??= { ...value };
      next[key] = redacted;
    }
  }
  return next ?? value;
}

/**
 * Only the end of a chunk can hold the start of a credential. The window covers the longest
 * unfinished credential: a name, its assignment, "Bearer " and a value of MAX_VALUE characters.
 */
const PARTIAL_WINDOW = 400;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Every non-empty prefix of the words, longest first, as one alternation. */
function prefixesOf(words: ReadonlyArray<string>): string {
  const prefixes = new Set(
    words.flatMap((word) => Array.from(word, (_, index) => word.slice(0, index + 1))),
  );
  const alternation = [...prefixes]
    .toSorted((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  return `(?:${alternation})`;
}

/**
 * Matches, at the end of the text, any unfinished start of something redactGoatCredentials would
 * redact: part of a credential name, a name waiting for its assignment or value, part of
 * "Bearer " (escaped spaces too), "Bearer " with up to a token of characters, or part of a tag or
 * a tagged run. Holding back from its match means the cut never splits a credential.
 */
function buildPartialCredential(): RegExp {
  // Before the = or :, including a JSON-escaped closing quote.
  const beforeDelimiter = String.raw`\\?["']?[ \t]{0,8}`;
  const bearerPrefix = String.raw`B(?:e(?:a(?:r(?:e(?:r(?:\\?[ \t]){0,8}\\?)?)?)?)?)?`;
  const alternatives = [
    prefixesOf(CREDENTIAL_NAMES),
    `${CREDENTIAL_NAME}${beforeDelimiter}`,
    `${CREDENTIAL_NAME}${ASSIGNMENT}(?:${bearerPrefix})?`,
    `${CREDENTIAL_NAME}${ASSIGNMENT}(?:${BEARER})?${VALUE_CHAR}{1,${MAX_VALUE}}`,
    `(?<![A-Za-z0-9])${bearerPrefix}`,
    `(?<![A-Za-z0-9])${BEARER}${TOKEN_CHAR}{0,${TOKEN_LENGTH}}`,
    ...(runTags.length === 0
      ? []
      : [prefixesOf(runTags), `(?:${runTags.join("|")})${TOKEN_CHAR}{0,${MAX_VALUE}}`]),
  ];
  return new RegExp(`(?:${alternatives.join("|")})$`, "i");
}

// What can stand right before a credential value: "Bearer " or a credential variable's assignment.
const LABEL_BEFORE_VALUE = new RegExp(
  `(?:(?<![A-Za-z0-9])${BEARER}|${CREDENTIAL_NAME}${ASSIGNMENT}(?:${BEARER})?)$`,
  "i",
);

/** Where the held-back tail starts: nothing before it can still become part of a credential. */
function partialStart(text: string, matches: ReadonlyArray<RegExpExecArray>): number {
  const windowStart = Math.max(0, text.length - PARTIAL_WINDOW);
  const partial = partialCredential.exec(text.slice(windowStart));
  let start = partial === null ? text.length : windowStart + partial.index;
  // The credentials already complete, the same matches the emitted text is redacted with. Only
  // those near the end can contain the cut.
  const spans = matches
    .filter((match) => match.index + match[0].length > windowStart - PARTIAL_WINDOW)
    .map((match) => ({ from: match.index, to: match.index + match[0].length }));
  let runStart = text.length;
  while (runStart > windowStart && TOKEN_CHARS.test(text.charAt(runStart - 1))) runStart -= 1;
  // Each rule only moves the cut back, so repeating them until none moves it ends on a cut that
  // satisfies all of them at once.
  for (let previous = -1; previous !== start;) {
    previous = start;
    // Never inside a complete credential, such as a tagged run that runs on into a name, or a
    // value that is itself a name.
    for (const { from, to } of spans) if (from < start && start < to) start = from;
    // Never inside the trailing run of token characters: the part shown now could be most of a
    // token whose label the redactor needs to see. Hold the run and the label before it.
    if (start < text.length && start > runStart) start = runStart;
    if (start === runStart && start < text.length) {
      const label = LABEL_BEFORE_VALUE.exec(text.slice(windowStart, start));
      if (label !== null) start -= label[0].length;
    }
  }
  return start;
}

/**
 * Redacts streamed output. emit is safe to show now; carry (at most a few hundred characters) is
 * held back and prefixed to the next chunk, or passed through {@link redactGoatCredentials} when
 * the stream ends.
 */
export function redactGoatCredentialChunk(
  carry: string,
  chunk: string,
): { readonly emit: string; readonly carry: string } {
  const text = carry + chunk;
  const matches = Array.from(text.matchAll(credential));
  const start = partialStart(text, matches);
  return { emit: redactBefore(text, start, matches), carry: text.slice(start) };
}
