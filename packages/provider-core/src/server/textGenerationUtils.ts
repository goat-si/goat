import { TextGenerationError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { strictOutputSchemaViolations } from "./strictOutputSchema.ts";

const isTextGenerationError = Schema.is(TextGenerationError);
const decodeJsonThreadTitle = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
);

export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(Schema.toType(schema), {
    onExcessProperty: "error",
  });
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/**
 * The JSON Schema for a structured-output request, refused here when a provider running strict
 * structured output would reject it, so the cause names GOAT's schema and the operation.
 */
export const toStrictJsonSchemaObject = (
  operation: TextGenerationError["operation"],
  schema: Schema.Top,
): Effect.Effect<unknown, TextGenerationError> => {
  const json = toJsonSchemaObject(schema);
  const violations = strictOutputSchemaViolations(json);
  return violations.length === 0
    ? Effect.succeed(json)
    : Effect.fail(
        new TextGenerationError({
          operation,
          detail: `Invalid schema for response_format: GOAT built an output schema a strict provider rejects. ${violations.join(" ")}`,
        }),
      );
};

export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    withoutTrailingPeriod,
  );
  let subject = "";
  for (const { segment } of segments) {
    if (subject.length + segment.length > 72) break;
    subject += segment;
  }
  return subject.trimEnd() || "Update project files";
}

export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

const MAX_THREAD_TITLE_CHARS = 120;

export function sanitizeThreadTitle(raw: string): string {
  // Unwrap a JSON-formatted title before truncation can cut off the closing brace.
  const decoded = decodeJsonThreadTitle(raw);
  const title = Option.isSome(decoded) ? decoded.value.title : raw;
  const normalized = title
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= MAX_THREAD_TITLE_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_THREAD_TITLE_CHARS - 3).trimEnd()}...`;
}

function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}

/** Why a text generation request failed, in terms a person can act on. */
export type TextGenerationFailureKind =
  | "schema_rejected"
  | "auth"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "invalid_output"
  | "failed";

// GOAT's own failure details are matched as whole sentences. Raw CLI output (stderr or the
// API's JSON error) is matched only on provider error codes and statuses, never on loose words
// that also occur in configuration keys or echoed text.
const FAILURE_RULES: ReadonlyArray<readonly [TextGenerationFailureKind, RegExp]> = [
  ["schema_rejected", /\binvalid_json_schema\b|^Invalid schema for response_format:/],
  [
    "auth",
    /"status":\s*401\b|\b401 Unauthorized\b|\bNot logged in\b|Please run \/login\b|\bauthentication_error\b|^Sign in with \w+ or add \w+ in provider settings\.$/,
  ],
  [
    "rate_limited",
    /"status":\s*429\b|\b429 Too Many Requests\b|\brate_limit_exceeded\b|\busage_limit_reached\b|You've hit your usage limit/,
  ],
  ["timeout", /^[\w .-]{1,60} timed out\.$/],
  [
    "unavailable",
    /^[\w .-]{1,40} is disabled( in GOAT settings)?\.$|^This provider (does not support channel reception|has no memory runner)\.$|^No provider instance registered for id |^route_unavailable$|^.{1,80} is required but not available on PATH\.$|^Could not verify the effective Codex endpoint\.$|^Could not read OpenCodex status/,
  ],
  [
    "invalid_output",
    /^[\w .-]{1,40} returned (invalid structured output|unexpected output format|empty( text generation)? output)\.$|^The model chose an action without the fields it needs\.$|^Memory (result|evidence or execution) is invalid\.$/,
  ],
];

/**
 * Classify a provider failure from its detail. Details carry raw CLI output, so callers show the
 * kind and keep the detail for logs.
 */
export function classifyTextGenerationFailure(
  error: Pick<TextGenerationError, "detail">,
): TextGenerationFailureKind {
  return FAILURE_RULES.find(([, pattern]) => pattern.test(error.detail))?.[0] ?? "failed";
}
