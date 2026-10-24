import { legacyEnvName } from "@goat/contracts/legacyT3Names";

/**
 * GOAT gives each agent a thread-scoped MCP bearer token in its shell environment
 * (GOAT_ACP_MCP_AUTHORIZATION, read by the goat CLI, the ACP bridge and the Computer Use lease
 * proxy), so an agent that dumps its environment prints it. Tool output is persisted, shown in
 * every client, and synced to remote viewers, so the token is scrubbed before it gets there
 * (#1201). The token itself is honored only while its provider session holds it.
 */

export const REDACTED_CREDENTIAL = "[redacted]";

const TOKEN_CHAR = "[A-Za-z0-9_-]";
// McpSessionRegistry mints an 8 character run tag plus a 43 character secret; older builds
// minted the bare secret.
const REGISTRY_TOKEN = String.raw`${TOKEN_CHAR}{43}(?:${TOKEN_CHAR}{8})?(?!${TOKEN_CHAR})`;
// Every variable GOAT puts a thread's MCP credential in, with the spelling older builds read.
const CREDENTIAL_NAMES: ReadonlyArray<string> = [
  "GOAT_ACP_MCP_AUTHORIZATION",
  "GOAT_MCP_AUTHORIZATION",
  "GOAT_MCP_BEARER_TOKEN",
  "GOAT_CUA_LEASE_AUTHORIZATION",
].flatMap((name) => [name, legacyEnvName(name) ?? name]);
const CREDENTIAL_NAME = `(?:${CREDENTIAL_NAMES.join("|")})`;
// An env, export or JSON dump: the name, an optional quote (JSON-escaped too), = or :.
const ASSIGNMENT = String.raw`\\?["']?[ \t]*[=:][ \t]*\\?["']?`;

const NAMED_VALUE = new RegExp(
  String.raw`(${CREDENTIAL_NAME}${ASSIGNMENT}(?:Bearer[ \t]+)?)[^\s"'\\,;]+`,
  "g",
);
const BEARER_VALUE = new RegExp(String.raw`(?<![A-Za-z0-9])(Bearer\s+)${REGISTRY_TOKEN}`, "gi");
const MAY_HOLD_CREDENTIAL = /bearer|_AUTHORIZATION|_BEARER_TOKEN/i;

/** Text with every GOAT MCP credential replaced by {@link REDACTED_CREDENTIAL}. */
export function redactGoatCredentials(text: string): string {
  if (!MAY_HOLD_CREDENTIAL.test(text)) return text;
  return text
    .replace(NAMED_VALUE, `$1${REDACTED_CREDENTIAL}`)
    .replace(BEARER_VALUE, `$1${REDACTED_CREDENTIAL}`);
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

// A chunk boundary can split a credential: "Bearer " with part of a token, a complete name still
// waiting for its value, or (below) a word that may grow into a name or "Bearer".
const PARTIAL_VALUE = new RegExp(
  String.raw`(?:(?<![A-Za-z0-9])Bearer\s+${TOKEN_CHAR}{0,50}|${CREDENTIAL_NAME}${ASSIGNMENT}(?:Bearer[ \t]*)?)$`,
  "i",
);
const TRAILING_WORD = /[A-Za-z0-9_]+$/;

function heldLength(text: string): number {
  const value = PARTIAL_VALUE.exec(text);
  if (value !== null) return value[0].length;
  const word = TRAILING_WORD.exec(text)?.[0];
  if (word === undefined) return 0;
  const growsIntoCredential =
    "bearer".startsWith(word.toLowerCase()) ||
    CREDENTIAL_NAMES.some((name) => name.startsWith(word));
  return growsIntoCredential ? word.length : 0;
}

/**
 * Redacts streamed output. emit is safe to show now; carry is held back and prefixed to the next
 * chunk, or passed through {@link redactGoatCredentials} when the stream ends.
 */
export function redactGoatCredentialChunk(
  carry: string,
  chunk: string,
): { readonly emit: string; readonly carry: string } {
  const text = carry + chunk;
  const held = text.slice(text.length - heldLength(text));
  return {
    emit: redactGoatCredentials(text.slice(0, text.length - held.length)),
    carry: held,
  };
}
