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

// A value after = or :, whole when it is quoted.
const VALUE = String.raw`(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|\S+)`;

/**
 * A quoted field name followed by a colon, in JSON escaped inside another JSON string, in JSON,
 * and in a single-quoted repr. Names are decoded before they are compared, so an escaped spelling
 * such as "to\u006ben" is still a token. Name length is bounded so scanning stays linear.
 */
const FIELD_NAMES = [
  {
    name: new RegExp(String.raw`\\"((?:\\\\(?:\\\\|\\"|[^\\"])|[^\\"]){1,128})\\"\s*:\s*`, "g"),
    escaped: true,
    decode: (raw: string) => jsonString(raw.replace(/\\(\\|")/g, "$1")),
  },
  {
    name: new RegExp(String.raw`"((?:\\.|[^"\\]){1,128})"\s*:\s*`, "g"),
    escaped: false,
    decode: jsonString,
  },
  {
    name: new RegExp(String.raw`'((?:\\.|[^'\\]){1,128})'\s*:\s*`, "g"),
    escaped: false,
    decode: (raw: string) => jsonString(raw.replace(/\\'/g, "'").replace(/"/g, '\\"')),
  },
];

function jsonString(body: string): string {
  try {
    const value: unknown = JSON.parse(`"${body}"`);
    return typeof value === "string" ? value : body;
  } catch {
    return body;
  }
}

const ESCAPED_QUOTE = '\\"';
const ESCAPED_BACKSLASH = "\\\\";

/**
 * Where the JSON value starting at start ends: a string up to its own closing quote, an array or
 * object up to its matching bracket, a bare value up to a separator. In escaped JSON, quotes and
 * backslashes are themselves escaped. A value that never closes runs to the end of the text, so a
 * cut or malformed value is hidden whole.
 */
function valueEnd(text: string, start: number, escaped: boolean): number {
  let depth = 0;
  let quote: string | undefined;
  let index = start;
  while (index < text.length) {
    if (quote !== undefined) {
      if (escaped) {
        if (text.startsWith(ESCAPED_BACKSLASH, index)) {
          const next = text.slice(index + 2, index + 4);
          index += next === ESCAPED_BACKSLASH || next === ESCAPED_QUOTE ? 4 : 3;
          continue;
        }
        if (text.startsWith(ESCAPED_QUOTE, index)) {
          quote = undefined;
          index += 2;
          if (depth === 0) return index;
          continue;
        }
      } else if (text[index] === "\\") {
        index += 2;
        continue;
      } else if (text[index] === quote) {
        quote = undefined;
        index += 1;
        if (depth === 0) return index;
        continue;
      }
      index += 1;
      continue;
    }
    const char = text.charAt(index);
    if (escaped ? text.startsWith(ESCAPED_QUOTE, index) : char === '"' || char === "'") {
      quote = escaped ? ESCAPED_QUOTE : char;
      index += quote.length;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      if (depth === 0) return index;
      depth -= 1;
      if (depth === 0) return index + 1;
    } else if (depth === 0 && (char === "," || char === "\\" || /\s/.test(char))) return index;
    index += 1;
  }
  return text.length;
}

/** Every credential-named field's whole value replaced; see {@link valueEnd}. */
function maskCredentialFields(text: string): string {
  let masked = text;
  for (const { name, escaped, decode } of FIELD_NAMES) {
    let out = "";
    let shown = 0;
    name.lastIndex = 0;
    for (let match = name.exec(masked); match !== null; match = name.exec(masked)) {
      if (match.index < shown || !isCredentialKey.test(decode(match[1] ?? ""))) continue;
      const start = match.index + match[0].length;
      const end = valueEnd(masked, start, escaped);
      out += masked.slice(shown, start) + MASK;
      shown = end;
      name.lastIndex = Math.max(end, start);
    }
    masked = out + masked.slice(shown);
  }
  return masked;
}

/** Whether a base64url part decodes to a JWT or JWE header: a JSON object naming its alg. */
function isJoseHeader(part: string): boolean {
  const decoded = Buffer.from(part, "base64url").toString("utf8");
  if (!/^\s*\{/.test(decoded)) return false;
  try {
    const header: unknown = JSON.parse(decoded);
    return typeof header === "object" && header !== null && "alg" in header;
  } catch {
    return false;
  }
}

/** A dotted run from its first part that is a JOSE header on, masked; otherwise the run itself. */
function maskJoseToken(run: string): string {
  const parts = run.split(".");
  for (let index = 0; index + 2 < parts.length; index++) {
    const part = parts[index] ?? "";
    if (part.length >= 8 && isJoseHeader(part)) return [...parts.slice(0, index), MASK].join(".");
  }
  return run;
}

const REDACTIONS: ReadonlyArray<readonly [RegExp, string | ((match: string) => string)]> = [
  // Cookie and Set-Cookie headers hold every cookie up to the end of the line.
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${MASK}`],
  // A JWT or JWE: dotted base64url parts led by one that decodes to a JSON header, whatever
  // whitespace the header holds. Each part of a dotted run is tried, so a dotted prefix cannot
  // hide a token, and dotted names such as serverLogger.test.ts are left alone.
  [/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){2,}/g, maskJoseToken],
  // https://user:token@host/repo.git; bounded so a long run without one stays linear.
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s@]{1,512}@/gi, `$1${MASK}@`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${MASK}`],
  [
    new RegExp(String.raw`\b(authorization\s*[=:]\s*)(?!(?:Bearer|Basic)\b)${VALUE}`, "gi"),
    `$1${MASK}`,
  ],
  [
    new RegExp(
      String.raw`\b((?:(?:access|refresh|id|session|client)[_-]?)?token|api[_-]?key|client[_-]?secret|secret|password|passwd)(\s*[=:]\s*)${VALUE}`,
      "gi",
    ),
    `$1$2${MASK}`,
  ],
];

const MAX_STRING = 32_000;
// Only the start of a huge text can be shown; scanning all of it would slow every log call.
const MAX_SCANNED = 8 * MAX_STRING;

/** Text with credentials replaced, then cut to a bound, so the cut never splits a credential. */
export function redactLogText(text: string): string {
  const scanned = text.length <= MAX_SCANNED ? text : text.slice(0, MAX_SCANNED);
  const redacted = REDACTIONS.reduce(
    (current, [pattern, replacement]) =>
      typeof replacement === "string"
        ? current.replace(pattern, replacement)
        : current.replace(pattern, replacement),
    maskCredentialFields(redactGoatCredentials(scanned)),
  );
  return redacted.length <= MAX_STRING && scanned === text
    ? redacted
    : `${redacted.slice(0, MAX_STRING)}…[cut from ${text.length} characters]`;
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
const MAX_TOTAL_CHARS = 64_000;
const MAX_BIGINT_DIGITS = 64;
const TRUNCATED = "[Truncated]";

/** One log call's allowance, shared by every value it visits, so no input can make it large. */
interface Budget {
  nodes: number;
  chars: number;
  // The objects on the path being copied, so only a real cycle is cut.
  readonly path: WeakSet<object>;
}

/**
 * A log message as inert data: strings redacted, causes and errors as redacted text, and every
 * other object copied from its own enumerable data properties, so no getter, toJSON or inspect
 * hook of the original reaches a sink. A credential-named field loses its whole value.
 */
export const redactLogMessage = (value: unknown): unknown =>
  sanitize(value, 0, { nodes: MAX_NODES, chars: MAX_TOTAL_CHARS, path: new WeakSet() });

const exhausted = (budget: Budget) => budget.nodes <= 0 || budget.chars <= 0;

/** Already redacted text, cut to what is left of the budget. */
function fit(redacted: string, budget: Budget): string {
  const kept =
    redacted.length <= budget.chars ? redacted : `${redacted.slice(0, Math.max(0, budget.chars))}…`;
  budget.chars -= kept.length;
  return kept;
}

const text = (value: string, budget: Budget) => fit(redactLogText(value), budget);

function sanitize(value: unknown, depth: number, budget: Budget): unknown {
  if (exhausted(budget)) return TRUNCATED;
  budget.nodes -= 1;
  switch (typeof value) {
    case "string":
      return text(value, budget);
    case "number":
    case "boolean":
    case "undefined":
      return value;
    case "bigint": {
      const digits = value.toString();
      return digits.length <= MAX_BIGINT_DIGITS ? value : fit(digits, budget);
    }
    case "symbol":
      return text(`Symbol(${value.description ?? ""})`, budget);
    case "function":
      return text(`[Function ${functionName(value)}]`, budget);
  }
  if (typeof value !== "object" || value === null) return null;
  if (budget.path.has(value)) return "[Circular]";
  if (depth > MAX_DEPTH) return TRUNCATED;
  budget.path.add(value);
  try {
    return sanitizeObject(value, depth, budget);
  } catch {
    // A revoked Proxy or a forged built-in can throw on any inspection; logging must not fail.
    return "[Uninspectable]";
  } finally {
    budget.path.delete(value);
  }
}

function sanitizeObject(value: object, depth: number, budget: Budget): unknown {
  if (Cause.isCause(value)) return fit(Cause.pretty(redactCause(value)), budget);
  if (value instanceof Error) return fit(sanitizedError(value).stack ?? "", budget);
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
  // Nothing is read from binary data: even its length can be an own getter.
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "[binary data]";
  // Intrinsic iteration: a subclass's own iterator never runs.
  if (value instanceof Map)
    return collect(Map.prototype.entries.call(value), budget, ([key, entry]) => [
      sanitize(key, depth + 1, budget),
      typeof key === "string" && isCredentialKey.test(key) && entry != null
        ? MASK
        : sanitize(entry, depth + 1, budget),
    ]);
  if (value instanceof Set)
    return collect(Set.prototype.values.call(value), budget, (entry) =>
      sanitize(entry, depth + 1, budget),
    );
  if (Array.isArray(value)) {
    const length = Number(Object.getOwnPropertyDescriptor(value, "length")?.value ?? 0);
    const indexes = (function* () {
      for (let index = 0; index < length; index++) yield index;
    })();
    return collect(indexes, budget, (index) =>
      property(Object.getOwnPropertyDescriptor(value, index), false, depth, budget),
    );
  }
  const projection: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (exhausted(budget)) {
      projection["…"] = TRUNCATED;
      break;
    }
    budget.nodes -= 1;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    projection[text(key, budget)] = property(descriptor, isCredentialKey.test(key), depth, budget);
  }
  return projection;
}

/** Items copied until the budget runs out, then a marker. */
function collect<T>(
  items: Iterable<T>,
  budget: Budget,
  each: (item: T) => unknown,
): Array<unknown> {
  const copied: Array<unknown> = [];
  for (const item of items) {
    if (exhausted(budget)) {
      copied.push(TRUNCATED);
      break;
    }
    // Every slot costs, including holes, getters and masked values that copy nothing.
    budget.nodes -= 1;
    copied.push(each(item));
  }
  return copied;
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

/** A function's own name, read without running a getter. */
function functionName(fn: Function): string {
  const name: unknown = Object.getOwnPropertyDescriptor(fn, "name")?.value;
  return typeof name === "string" && name.length > 0 ? name : "anonymous";
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

/** What a log call shows when redaction itself fails: never the unredacted value. */
function guarded<A>(redact: () => A, fallback: A): A {
  try {
    return redact();
  } catch {
    return fallback;
  }
}

/** A sink that sees each log call only after redaction. */
export const redacting = <Output>(logger: Logger.Logger<unknown, Output>) =>
  Logger.make<unknown, Output>((options) =>
    logger.log({
      ...options,
      message: guarded(() => redactLogMessage(options.message), "[unloggable message]"),
      cause: guarded(() => redactCause(options.cause), Cause.die(new Error("unloggable cause"))),
      fiber: guarded(() => redactedFiber(options.fiber), options.fiber),
    }),
  );

/** {@link redacting} for a sink an effect builds, such as the OTLP logger. */
export const redactingEffect = <Output, E, R>(
  logger: Effect.Effect<Logger.Logger<unknown, Output>, E, R>,
) => Effect.map(logger, redacting);
