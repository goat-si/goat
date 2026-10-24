import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Redactable from "effect/Redactable";
import * as References from "effect/References";

import { redactGoatCredentials } from "../mcp/goatCredentialRedaction.ts";

/**
 * What the server's logs may carry: everything a log call passes reaches a sink (console, a span
 * event, an OTLP record) only after it has been turned into inert, bounded data with credentials
 * replaced (#1388). Errors keep their name, message and stack, never their other fields, which
 * can hold request headers or tokens.
 */

const MASK = "***";

// A field name whose value is a credential, in snake, kebab or camel case.
const CREDENTIAL_KEY = String.raw`(?:(?:access|refresh|id|session|auth|bearer|csrf|xsrf|api|client)[_-]?)?token|(?:x[_-])?api[_-]?key|client[_-]?secret|secret|password|passwd|authorization|(?:set[_-]?)?cookie`;
const isCredentialKey = new RegExp(`^(?:${CREDENTIAL_KEY})$`, "i");
// A quote, JSON-escaped or not.
const QUOTE = String.raw`\\?["']`;

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // "set-cookie": ["a=1", "b=2"]
  [new RegExp(String.raw`(${QUOTE}set-cookie${QUOTE}\s*:\s*)\[[^\]]*\]`, "gi"), `$1["${MASK}"]`],
  // "access_token": "value", in JSON, escaped JSON or a dict repr
  [
    new RegExp(
      String.raw`(${QUOTE}(?:${CREDENTIAL_KEY})${QUOTE}\s*:\s*${QUOTE})(?:[^"'\\]|\\(?!["']))*`,
      "gi",
    ),
    `$1${MASK}`,
  ],
  // Cookie and Set-Cookie headers hold every cookie up to the end of the line.
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${MASK}`],
  // A JWT: a JSON header, a payload and a signature, each base64url.
  [/\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g, MASK],
  // https://user:token@host/repo.git
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${MASK}@`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${MASK}`],
  [/\b(authorization\s*[=:]\s*)(?!(?:Bearer|Basic)\b)\S+/gi, `$1${MASK}`],
  [
    /\b((?:(?:access|refresh|id|session|client)[_-]?)?token|api[_-]?key|client[_-]?secret|secret|password|passwd)(\s*[=:]\s*)\S+/gi,
    `$1$2${MASK}`,
  ],
];

const MAX_STRING = 32_000;

/** Text with credentials replaced, then cut to a bound, so the cut never splits a credential. */
export function redactLogText(text: string): string {
  const redacted = REDACTIONS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    redactGoatCredentials(text),
  );
  return redacted.length <= MAX_STRING
    ? redacted
    : `${redacted.slice(0, MAX_STRING)}…[${redacted.length - MAX_STRING} more characters]`;
}

const DEFECT_SUMMARY_MAX_CHARS = 2_000;

/** What died, for one log line: an Error's stack or message, never its fields. */
export const defectSummary = (defect: unknown): string => {
  if (!(defect instanceof Error)) return `non-Error defect (${typeof defect})`;
  const text =
    diagnostic(defect, "stack") ??
    `${diagnostic(defect, "name") ?? "Error"}: ${diagnostic(defect, "message") ?? ""}`;
  return redactLogText(text).slice(0, DEFECT_SUMMARY_MAX_CHARS);
};

/**
 * An Error's diagnostics, read the way Effect reads them when it renders a cause: through the
 * prototype chain, so inherited names and getter-defined messages survive. A throwing getter
 * yields nothing.
 */
function diagnostic(error: Error, key: "name" | "message" | "stack"): string | undefined {
  try {
    const value: unknown = Reflect.get(error, key);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

const MAX_CAUSE_DEPTH = 3;
const MAX_REASONS = 16;
const MAX_NAME_CHARS = 200;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_STACK_CHARS = 8_000;

/**
 * The cause as fresh Errors holding only a redacted name, message, stack and Error cause chain.
 * Rebuilt reasons carry no annotations: Effect prints annotation frames after the Error, outside
 * any redaction, so the frames are rendered here instead and redacted with the rest.
 */
export const redactCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> => {
  if (cause.reasons.length === 0) return cause;
  const reasons = cause.reasons.slice(0, MAX_REASONS).map(redactReason);
  if (cause.reasons.length > MAX_REASONS)
    reasons.push(
      Cause.makeDieReason(new Error(`${cause.reasons.length - MAX_REASONS} more reasons omitted`)),
    );
  return Cause.fromReasons(reasons);
};

function redactReason(reason: Cause.Reason<unknown>): Cause.Reason<unknown> {
  switch (reason._tag) {
    case "Fail":
      return Cause.makeFailReason(sanitizedError(reason.error, reason.annotations));
    case "Die":
      return Cause.makeDieReason(sanitizedError(reason.defect, reason.annotations));
    case "Interrupt":
      return Cause.makeInterruptReason(reason.fiberId);
  }
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function causeOf(error: Error): unknown {
  try {
    return Reflect.get(error, "cause");
  } catch {
    return undefined;
  }
}

function sanitizedError(
  value: unknown,
  annotations?: ReadonlyMap<string, unknown>,
  seen: Set<unknown> = new Set(),
  depth = 0,
): Error {
  const frames = annotations === undefined ? "" : annotationFrames(annotations);
  if (!(value instanceof Error)) {
    // A thrown string is a message; any other value is named by its type, never printed.
    const message =
      typeof value === "string"
        ? bounded(redactLogText(value), MAX_MESSAGE_CHARS)
        : `non-Error ${value === null ? "null" : typeof value}`;
    const error = new Error(message);
    error.stack = `Error: ${message}${frames}`;
    return error;
  }
  seen.add(value);
  const name = bounded(redactLogText(diagnostic(value, "name") ?? "Error"), MAX_NAME_CHARS);
  const message = bounded(redactLogText(diagnostic(value, "message") ?? ""), MAX_MESSAGE_CHARS);
  const nested = causeOf(value);
  const error =
    nested instanceof Error && !seen.has(nested) && depth < MAX_CAUSE_DEPTH
      ? new Error(message, { cause: sanitizedError(nested, undefined, seen, depth + 1) })
      : new Error(message);
  error.name = name;
  // The stack starts by repeating the message; keep its frames beneath the redacted header.
  const stack = diagnostic(value, "stack") ?? "";
  const firstFrame = stack.indexOf("\n    at ");
  const stackFrames = firstFrame === -1 ? "" : redactLogText(stack.slice(firstFrame));
  error.stack = bounded(`${name}: ${message}${stackFrames}${frames}`, MAX_STACK_CHARS);
  return error;
}

/** The span frames Effect would print for these annotations, rendered once and redacted. */
function annotationFrames(annotations: ReadonlyMap<string, unknown>): string {
  if (annotations.size === 0) return "";
  try {
    const placeholder = new Error("frames");
    placeholder.stack = "Error: frames";
    const reason = Cause.makeDieReason(placeholder).annotate(
      Context.makeUnsafe(new Map(annotations)),
    );
    const rendered = Cause.prettyErrors(Cause.fromReasons([reason]))[0]?.stack ?? "";
    const firstFrame = rendered.indexOf("\n");
    return firstFrame === -1 ? "" : redactLogText(rendered.slice(firstFrame));
  } catch {
    return "";
  }
}

const MAX_DEPTH = 8;
const MAX_NODES = 2_000;

interface Budget {
  nodes: number;
  // The objects on the path being copied, so only a real cycle is cut.
  readonly path: WeakSet<object>;
}

/**
 * A log message as inert data: strings redacted, causes and errors as redacted text, and every
 * other object copied from its own enumerable data properties, so no getter, toJSON or inspect
 * hook of the original reaches a sink. A credential-named field loses its whole value.
 */
export const redactLogMessage = (value: unknown): unknown =>
  sanitize(value, 0, { nodes: MAX_NODES, path: new WeakSet() });

function sanitize(value: unknown, depth: number, budget: Budget): unknown {
  switch (typeof value) {
    case "string":
      return redactLogText(value);
    case "number":
    case "boolean":
    case "undefined":
    case "bigint":
      return value;
    case "symbol":
      return `Symbol(${redactLogText(value.description ?? "")})`;
    case "function":
      return `[Function ${redactLogText(value.name || "anonymous")}]`;
  }
  if (value === null) return null;
  if (budget.path.has(value)) return "[Circular]";
  budget.nodes -= 1;
  if (budget.nodes < 0 || depth > MAX_DEPTH) return "[Truncated]";
  budget.path.add(value);
  try {
    return sanitizeObject(value, depth, budget);
  } finally {
    budget.path.delete(value);
  }
}

function sanitizeObject(value: object, depth: number, budget: Budget): unknown {
  if (Cause.isCause(value)) return Cause.pretty(redactCause(value));
  if (value instanceof Error) return sanitizedError(value).stack;
  if (value instanceof Date) return dateText(value);
  if (Redactable.isRedactable(value)) {
    // The hook decides what the value shows; what it returns is still sanitized.
    let redacted: unknown;
    try {
      redacted = Redactable.redact(value);
    } catch {
      return "[Redactable]";
    }
    return sanitize(redacted, depth, budget);
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    return `[binary ${value.byteLength} bytes]`;
  if (value instanceof Map)
    return Array.from(value, ([key, entry]) => [
      sanitize(key, depth + 1, budget),
      sanitize(entry, depth + 1, budget),
    ]);
  if (value instanceof Set) return Array.from(value, (entry) => sanitize(entry, depth + 1, budget));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value))
    return Array.from(value, (_, index) =>
      property(descriptors[String(index)], false, depth, budget),
    );
  const projection: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    projection[redactLogText(key)] = property(descriptor, isCredentialKey.test(key), depth, budget);
  }
  return projection;
}

function property(
  descriptor: PropertyDescriptor | undefined,
  credential: boolean,
  depth: number,
  budget: Budget,
): unknown {
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) return "[Getter]";
  if (credential && descriptor.value !== undefined && descriptor.value !== null) return MASK;
  return sanitize(descriptor.value, depth + 1, budget);
}

function dateText(date: Date): string {
  try {
    return Date.prototype.toISOString.call(date);
  } catch {
    return "Invalid Date";
  }
}

/**
 * The fiber a sink reads, with its log annotations and log span labels redacted. Sinks read both
 * straight from the fiber, and GOAT annotates logs with errors, so redacting the message is not
 * enough. The live fiber is left untouched.
 */
function redactedFiber(fiber: Fiber.Fiber<unknown, unknown>): Fiber.Fiber<unknown, unknown> {
  const annotations = fiber.getRef(References.CurrentLogAnnotations);
  const spans = fiber.getRef(References.CurrentLogSpans);
  if (Object.keys(annotations).length === 0 && spans.length === 0) return fiber;
  const safeAnnotations = redactLogMessage(annotations);
  const safeSpans = spans.map(([label, startTime]) => [redactLogText(label), startTime]);
  return new Proxy(fiber, {
    get(target, key) {
      if (key === "getRef")
        return (reference: unknown) =>
          reference === References.CurrentLogAnnotations
            ? safeAnnotations
            : reference === References.CurrentLogSpans
              ? safeSpans
              : target.getRef(reference as Context.Reference<unknown>);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A sink that sees each log call only after redaction. */
export const redacting = <Output>(logger: Logger.Logger<unknown, Output>) =>
  Logger.make<unknown, Output>((options) =>
    logger.log({
      ...options,
      message: redactLogMessage(options.message),
      cause: redactCause(options.cause),
      fiber: redactedFiber(options.fiber),
    }),
  );

/** {@link redacting} for a sink an effect builds, such as the OTLP logger. */
export const redactingEffect = <Output, E, R>(
  logger: Effect.Effect<Logger.Logger<unknown, Output>, E, R>,
) => Effect.map(logger, redacting);
