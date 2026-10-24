import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import type * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Redactable from "effect/Redactable";
import * as References from "effect/References";

import { isCredentialKey, MASK, redactLogText } from "./LogTextRedaction.ts";

/**
 * The guarantee of the server's log redaction (#1388), in every sink serverLogger installs (console,
 * tracer span events, OTLP log records) and in DefectReporter's output:
 * - Masked whole: GOAT MCP credentials; bare JWT and JWE tokens; Authorization header values
 *   (Bearer, Basic or any scheme); Cookie and Set-Cookie headers; and the values of JSON fields,
 *   structured log fields and key=value assignments whose name is in the fixed CREDENTIAL_KEY list
 *   (LogTextRedaction.ts), plus URL userinfo and a few provider token shapes.
 * - Errors keep their name, message, stack and Error cause chain and lose every other field.
 * - Logging never fails, runs no getter, hook or method of a logged value (apart from an Error's
 *   name/message/stack/cause, read as Effect reads them, and a Redactable's own hook), and costs
 *   time linear in its input, also on adversarial input.
 * Secrets of any other shape are outside it. Memory text is redacted separately, before its
 * operation digest (memory/MemorySecretScanner.ts).
 */

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

const MAX_CAUSE_DEPTH = 16;
const MAX_REASONS = 16;
// Reasons one report visits; a list claiming more is counted, not walked.
const MAX_VISITED_REASONS = 100_000;
const MAX_NAME_CHARS = 200;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_STACK_CHARS = 8_000;

/**
 * The cause as fresh Errors holding only a redacted name, message, stack and Error cause chain.
 * Rebuilt reasons carry no annotations: Effect prints annotation frames after the Error, outside
 * any redaction, so the frames are rendered here instead and redacted with the rest.
 */
export const redactCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> => {
  const { reasons, total } = reasonSnapshot(cause);
  const redacted = reasons.map(redactReason);
  if (total > reasons.length)
    redacted.push(Cause.makeDieReason(new Error(`${total - reasons.length} more reasons omitted`)));
  return Cause.fromReasons(redacted);
};

/**
 * Each Die reason of a reported cause as its own redacted cause, skipping defects Effect marks as
 * ignored (an ErrorReporter.ignore data property set to true, own or inherited, as Effect checks
 * it). Every reason is visited, read through descriptors; a reason whose kind cannot be read is
 * reported as an uninspectable defect, and defects past the first few are counted, not dropped.
 */
export const redactedDefects = (cause: Cause.Cause<unknown>): Array<Cause.Cause<unknown>> => {
  const listed = dataProperty(cause, "reasons");
  const total = listLength(listed);
  const defects: Array<Cause.Cause<unknown>> = [];
  const ignored = new Map<object, boolean>();
  const budget = { steps: MAX_PROTOTYPE_STEPS };
  let omitted = 0;
  const visited = Math.min(total, MAX_VISITED_REASONS);
  for (let index = 0; index < visited; index++) {
    const reason = dataProperty(listed, index);
    const tag = dataProperty(reason, "_tag");
    if (tag === "Fail" || tag === "Interrupt") continue;
    if (ignoredDefect(dataProperty(reason, "defect"), ignored, budget)) continue;
    if (defects.length < MAX_REASONS) defects.push(Cause.fromReasons([redactReason(reason)]));
    else omitted += 1;
  }
  if (omitted > 0) defects.push(Cause.die(new Error(`${omitted} more defects omitted`)));
  if (total > visited)
    defects.push(Cause.die(new Error(`${total - visited} more reasons not inspected`)));
  return defects;
};

function listLength(listed: unknown): number {
  return guarded(() => (Array.isArray(listed) ? arrayLength(listed) : 0), 0);
}

/**
 * An array's length as its own data property holds it, when that is a valid length; nothing is
 * coerced, so a forged length runs no valueOf and cannot claim Infinity.
 */
function arrayLength(target: unknown): number {
  const length = dataProperty(target, "length");
  return typeof length === "number" &&
    Number.isInteger(length) &&
    length >= 0 &&
    length <= 2 ** 32 - 1
    ? length
    : 0;
}

// Prototype steps one report may take; only a Proxy inventing a fresh prototype each step gets near.
const MAX_PROTOTYPE_STEPS = 100_000;

/**
 * Whether a defect carries Effect's ignore marker as a data property, on itself or a prototype.
 * Answers are cached per report, so defects sharing a chain walk it once, and a chain a Proxy
 * reports as cyclic or endless stops at a repeat or at the step budget; the defect is then
 * reported rather than hidden.
 */
function ignoredDefect(
  defect: unknown,
  cache: Map<object, boolean>,
  budget: { steps: number },
): boolean {
  const path: Array<object> = [];
  const onPath = new Set<object>();
  const result = guarded(() => {
    let current: unknown = defect;
    while (typeof current === "object" && current !== null) {
      const known = cache.get(current);
      if (known !== undefined) return known;
      if (onPath.has(current) || --budget.steps < 0) return false;
      path.push(current);
      onPath.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, ErrorReporter.ignore);
      if (descriptor !== undefined) return "value" in descriptor && descriptor.value === true;
      current = Object.getPrototypeOf(current);
    }
    return false;
  }, false);
  for (const object of path) cache.set(object, result);
  return result;
}

/**
 * A cause's first reasons and their count, read once through descriptors: neither the cause nor
 * its list can run code that shows a sink something other than what is redacted here.
 */
function reasonSnapshot(cause: Cause.Cause<unknown>): {
  readonly reasons: Array<unknown>;
  readonly total: number;
} {
  const listed = dataProperty(cause, "reasons");
  const total = listLength(listed);
  const reasons: Array<unknown> = [];
  for (let index = 0; index < Math.min(total, MAX_REASONS); index++)
    reasons.push(dataProperty(listed, index));
  return { reasons, total };
}

/** An own data property's value; a getter, a missing property or a throwing object give nothing. */
function dataProperty(target: unknown, key: PropertyKey): unknown {
  return guarded(() => {
    if (typeof target !== "object" || target === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  }, undefined);
}

function redactReason(reason: unknown): Cause.Reason<unknown> {
  const annotations = dataProperty(reason, "annotations");
  const frames = guarded(() => (annotations instanceof Map ? annotations : undefined), undefined);
  switch (dataProperty(reason, "_tag")) {
    case "Fail":
      return Cause.makeFailReason(sanitizedError(dataProperty(reason, "error"), frames));
    case "Die":
      return Cause.makeDieReason(sanitizedError(dataProperty(reason, "defect"), frames));
    case "Interrupt": {
      const fiberId = dataProperty(reason, "fiberId");
      return Cause.makeInterruptReason(typeof fiberId === "number" ? fiberId : undefined);
    }
    default:
      return Cause.makeDieReason(uninspectable());
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

/**
 * {@link inspectError} behind a guard: a revoked Proxy or a throwing getter anywhere in an error or
 * its cause chain becomes inert text, so recording a defect can never fail.
 */
function sanitizedError(
  value: unknown,
  annotations?: ReadonlyMap<string, unknown>,
  seen: Set<unknown> = new Set(),
  depth = 0,
): Error {
  try {
    return inspectError(value, annotations, seen, depth);
  } catch {
    return uninspectable();
  }
}

function uninspectable(): Error {
  return marker("[uninspectable]");
}

function marker(text: string): Error {
  const error = new Error(text);
  error.stack = `Error: ${text}`;
  return error;
}

function inspectError(
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
  const rawName = diagnostic(value, "name") ?? "Error";
  const rawMessage = diagnostic(value, "message") ?? "";
  const name = bounded(redactLogText(rawName), MAX_NAME_CHARS);
  const message = bounded(redactLogText(rawMessage), MAX_MESSAGE_CHARS);
  const nested = causeOf(value);
  let cause: Error | undefined;
  try {
    if (nested instanceof Error && !seen.has(nested))
      cause =
        depth < MAX_CAUSE_DEPTH
          ? sanitizedError(nested, undefined, seen, depth + 1)
          : marker("[deeper causes omitted]");
  } catch {
    // A revoked Proxy as a cause throws on instanceof; the outer error still shows.
    cause = uninspectable();
  }
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.name = name;
  // A V8 stack starts by repeating the message, which may span lines; other engines' stacks may
  // not. Whatever the format, everything after that header is kept as frames, redacted.
  const stack = diagnostic(value, "stack") ?? "";
  const header = `${rawName}: ${rawMessage}`;
  const afterHeader = stack.startsWith(header)
    ? stack.slice(header.length)
    : // Without its own header (some engines, or a rewritten stack) the whole stack is frames.
      `\n${stack}`;
  const stackFrames = afterHeader.trim().length === 0 ? "" : redactLogText(afterHeader);
  error.stack = bounded(`${name}: ${message}${stackFrames}${frames}`, MAX_STACK_CHARS);
  return error;
}

const MAX_FRAMES = 10;

/**
 * The span names Effect would print as frames for these annotations, read as data: Effect renders
 * a frame by calling its own stack() and reading getters, which a forged frame could abuse, so only
 * each frame's name and parent are read, through descriptors.
 */
function annotationFrames(annotations: ReadonlyMap<string, unknown>): string {
  const lines: Array<string> = [];
  let frame = guarded(() => Map.prototype.get.call(annotations, Cause.StackTrace.key), undefined);
  // Frames are counted as they are visited, named or not, so a cyclic chain still ends.
  for (let visited = 0; frame !== undefined && visited < MAX_FRAMES; visited++) {
    const name = dataProperty(frame, "name");
    if (typeof name === "string")
      lines.push(`    at ${bounded(redactLogText(name), MAX_NAME_CHARS)}`);
    frame = dataProperty(frame, "parent");
  }
  return lines.length === 0 ? "" : `\n${lines.join("\n")}`;
}

const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
const MAX_TOTAL_CHARS = 64_000;
const BIGINT_LIMIT = 10n ** 64n;
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
      // Decimal conversion of a huge bigint is super-linear, so its size is told in bits instead.
      if (value < BIGINT_LIMIT && value > -BIGINT_LIMIT) return value;
      return `[bigint of ${value.toString(16).length * 4} bits]`;
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
  // Rendered like a cause, so the sanitized Error cause chain shows as Effect would print it.
  if (value instanceof Error)
    return fit(
      Cause.pretty(Cause.fromReasons([Cause.makeDieReason(sanitizedError(value))])),
      budget,
    );
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
    const length = arrayLength(value);
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
 * The fiber a sink reads, with its log annotations and log span labels replaced by a redacted
 * snapshot taken once here. Sinks read both straight from the fiber, and GOAT annotates logs with
 * errors, so redacting the message is not enough. The live fiber is left untouched; when the
 * snapshot cannot be taken, the sink sees no annotations or spans rather than the live ones.
 */
function redactedFiber(fiber: Fiber.Fiber<unknown, unknown>): Fiber.Fiber<unknown, unknown> {
  const { annotations, spans } = redactedLogContext(fiber);
  return new Proxy(fiber, {
    get(target, key) {
      if (key === "getRef")
        return (reference: unknown) =>
          reference === References.CurrentLogAnnotations
            ? annotations
            : reference === References.CurrentLogSpans
              ? spans
              : target.getRef(reference as Context.Reference<unknown>);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A fiber's log annotations and log spans as a redacted snapshot; empty when it cannot be taken. */
function redactedLogContext(fiber: Fiber.Fiber<unknown, unknown>): {
  readonly annotations: Record<string, unknown>;
  readonly spans: Array<[string, number]>;
} {
  const projected = guarded(
    () => redactLogMessage(fiber.getRef(References.CurrentLogAnnotations)),
    {},
  );
  return {
    annotations:
      typeof projected === "object" && projected !== null && !Array.isArray(projected)
        ? Object.fromEntries(Object.entries(projected))
        : {},
    spans: guarded(
      () =>
        spanSnapshot(fiber.getRef(References.CurrentLogSpans)).map(
          ([label, startTime]): [string, number] => [label, startTime],
        ),
      [],
    ),
  };
}

/**
 * Effect.logError with the fiber's log annotations and spans redacted, for a log call made outside
 * the sink wrapper's reach, such as DefectReporter's: whatever logger receives it sees no raw
 * annotation or span label.
 */
export const logErrorRedacted = (message: string, cause: Cause.Cause<unknown>) =>
  Effect.withFiber((fiber) => {
    const { annotations, spans } = redactedLogContext(fiber);
    return Effect.logError(message, cause).pipe(
      Effect.provideService(References.CurrentLogAnnotations, annotations),
      Effect.provideService(References.CurrentLogSpans, spans),
    );
  });

const MAX_SPANS = 64;

/** Log span labels and start times, read through descriptors so no method of the list runs. */
function spanSnapshot(spans: unknown): Array<readonly [string, number]> {
  if (!Array.isArray(spans)) return [];
  const length = arrayLength(spans);
  const snapshot: Array<readonly [string, number]> = [];
  for (let index = 0; index < Math.min(length, MAX_SPANS); index++) {
    const entry: unknown = Object.getOwnPropertyDescriptor(spans, index)?.value;
    if (!Array.isArray(entry)) continue;
    const label: unknown = Object.getOwnPropertyDescriptor(entry, 0)?.value;
    const startTime: unknown = Object.getOwnPropertyDescriptor(entry, 1)?.value;
    snapshot.push([
      typeof label === "string" ? redactLogText(label) : "[span]",
      typeof startTime === "number" ? startTime : 0,
    ]);
  }
  return snapshot;
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
      fiber: redactedFiber(options.fiber),
    }),
  );
