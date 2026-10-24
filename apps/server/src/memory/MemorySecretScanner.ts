import * as Effect from "effect/Effect";

import { redactGoatCredentials } from "../mcp/goatCredentialRedaction.ts";

/** Scanner reports rule identifiers only; inspected strings never leave this boundary. */
export type MemoryScanResult =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "blocked";
      readonly ruleIds: ReadonlyArray<string>;
      readonly inspectedBytes: number;
    };

export const MEMORY_SCANNER_POLICY_VERSION = 1;
const rules = [
  ["pem_private_key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  [
    "provider_token",
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  ],
  ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
] as const;
// Authority/provenance IDs are validated by strict codecs, not scanned as prose.
const contentFields = new Set([
  "text",
  "judgment",
  "messages",
  "payload",
  "payloads",
  "resolutionPayload",
  "originals",
  "inputs",
  "result",
]);
export function scanMemoryValue(value: unknown): MemoryScanResult {
  const found = new Set<string>();
  let inspectedBytes = 0;
  const inspect = (input: unknown, content: boolean): void => {
    if (typeof input === "string") {
      if (!content) return;
      inspectedBytes += new TextEncoder().encode(input).length;
      for (const [id, pattern] of rules) if (pattern.test(input)) found.add(id);
    } else if (Array.isArray(input)) {
      for (const child of input) inspect(child, content);
    } else if (input !== null && typeof input === "object") {
      for (const [key, child] of Object.entries(input)) inspect(child, contentFields.has(key));
    }
  };
  inspect(value, typeof value === "string");
  return found.size === 0
    ? { kind: "allowed" }
    : { kind: "blocked", ruleIds: [...found].sort(), inspectedBytes };
}

/**
 * Memory text this environment writes holds no GOAT MCP credential: an agent can paste its own
 * thread credential into a memory, a model can repeat one it read, and memories sync to other
 * devices (#1297). Callers apply this before an operation is built and hashed. Received
 * operations are signed by their author and are never rewritten.
 */
export const redactMemoryText = <T extends { readonly text: string; readonly judgment?: string }>(
  value: T,
): T => ({
  ...value,
  text: redactGoatCredentials(value.text),
  ...(value.judgment === undefined ? {} : { judgment: redactGoatCredentials(value.judgment) }),
});

/** A summary or resolution generation whose result is passed through {@link redactMemoryText}. */
export const redacted = <
  O extends { readonly result: Parameters<typeof redactMemoryText>[0] },
  E,
  R,
>(
  generation: Effect.Effect<O, E, R>,
): Effect.Effect<O, E, R> =>
  Effect.map(generation, (output) => ({ ...output, result: redactMemoryText(output.result) }));
