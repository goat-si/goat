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

const NAMED_VALUE = new RegExp(
  `(${CREDENTIAL_NAME}${ASSIGNMENT}(?:${BEARER})?)${VALUE_CHAR}+`,
  "g",
);
const BEARER_VALUE = new RegExp(`(?<![A-Za-z0-9])(${BEARER})${REGISTRY_TOKEN}`, "gi");
const MAY_HOLD_LABELED_CREDENTIAL = /bearer|_AUTHORIZATION|_BEARER_TOKEN/i;

/** Run tags of the registries in this process; tests make many, production one. */
const runTags: Array<string> = [];
const MAX_RUN_TAGS = 32;
let taggedValue: RegExp | undefined;

/** Called by McpSessionRegistry with the tag that starts every token it mints. */
export function registerCredentialRunTag(tag: string): void {
  if (!TOKEN_CHARS.test(tag) || runTags.includes(tag)) return;
  runTags.push(tag);
  if (runTags.length > MAX_RUN_TAGS) runTags.shift();
  taggedValue = new RegExp(`(?:${runTags.join("|")})${TOKEN_CHAR}*`, "g");
}

/** Text with every GOAT MCP credential replaced by {@link REDACTED_CREDENTIAL}. */
export function redactGoatCredentials(text: string): string {
  let redacted = taggedValue === undefined ? text : text.replace(taggedValue, REDACTED_CREDENTIAL);
  if (MAY_HOLD_LABELED_CREDENTIAL.test(redacted)) {
    redacted = redacted
      .replace(NAMED_VALUE, `$1${REDACTED_CREDENTIAL}`)
      .replace(BEARER_VALUE, `$1${REDACTED_CREDENTIAL}`);
  }
  return redacted;
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

/** Only the end of a chunk can hold the start of a credential; this bounds work and carry. */
const PARTIAL_WINDOW = 320;
const PARTIAL_LABELED = new RegExp(
  `(?:(?<![A-Za-z0-9])${BEARER}${TOKEN_CHAR}{0,50}|${CREDENTIAL_NAME}${ASSIGNMENT}(?:${BEARER})?${VALUE_CHAR}{0,256})$`,
  "i",
);
const LONGEST_NAME = Math.max(...CREDENTIAL_NAMES.map((name) => name.length));

/** Start of the shortest-to-longest tail that a later chunk may turn into a credential. */
function partialStart(text: string): number {
  const windowStart = Math.max(0, text.length - PARTIAL_WINDOW);
  let start = text.length;
  const labeled = PARTIAL_LABELED.exec(text.slice(windowStart));
  if (labeled !== null) start = windowStart + labeled.index;
  // A token minted here, cut short.
  for (let index = Math.max(0, text.length - TOKEN_LENGTH + 1); index < start; index += 1) {
    const tail = text.slice(index);
    if (!TOKEN_CHARS.test(tail)) continue;
    if (
      runTags.some((tag) =>
        tail.length < tag.length ? tag.startsWith(tail) : tail.startsWith(tag),
      )
    ) {
      start = index;
      break;
    }
  }
  // A word that may still grow into a credential name or "Bearer".
  let wordStart = text.length;
  while (
    wordStart > 0 &&
    text.length - wordStart < LONGEST_NAME &&
    /[A-Za-z0-9_]/.test(text.charAt(wordStart - 1))
  ) {
    wordStart -= 1;
  }
  const word = text.slice(wordStart);
  if (
    wordStart < start &&
    word.length > 0 &&
    ("bearer".startsWith(word.toLowerCase()) ||
      CREDENTIAL_NAMES.some((name) => name.startsWith(word)))
  ) {
    start = wordStart;
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
  const start = partialStart(text);
  return { emit: redactGoatCredentials(text.slice(0, start)), carry: text.slice(start) };
}
