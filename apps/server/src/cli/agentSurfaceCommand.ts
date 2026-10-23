// @effect-diagnostics nodeBuiltinImport:off - argv reading runs before any Effect runtime exists.
import * as NodeFS from "node:fs";

import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "@goat/contracts/agentSurface";
import { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * `goat call`, `goat describe` and the `goat <resource> <verb>` commands generated from the
 * registry (docs/internals/agent-surface.md, "The goat command"). This module only reads argv
 * and the registry; every call it describes runs as one goat_call on the origin's /mcp.
 */

export type CallEffect = AgentSurfaceRegistryEntry["effect"];

export type AgentSurfaceInvocation =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "usage"; readonly message: string }
  | {
      readonly kind: "call";
      readonly path: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly json: boolean;
      /** Decides whether a lost answer may be retried; an unknown path counts as a write. */
      readonly effect: CallEffect;
      readonly format: "value" | "describe";
      /** The registry path the call resolved to, when it names one. */
      readonly entryPath?: string;
    };

/** Where `-` and `@file` read from, so tests need no real stdin or files. */
export interface InputReader {
  readonly stdin: () => string;
  readonly file: (path: string) => string;
}

export const nodeInputReader: InputReader = {
  stdin: () => NodeFS.readFileSync(0, "utf8"),
  file: (path) => NodeFS.readFileSync(path, "utf8"),
};

/**
 * Operator commands that predate the registry keep their meaning; generated verbs fill in the
 * rest of these resources. agentSurfaceCommand.test.ts checks this against binCli.
 */
export const OPERATOR_VERBS: Readonly<Record<string, ReadonlyArray<string>>> = {
  thread: ["list", "start", "send", "show"],
  project: ["add", "remove", "rename"],
  provider: ["diagnose"],
};

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  needsHuman: 3,
  retryable: 4,
  unknownOutcome: 5,
  /** goat operation wait: the deadline came while the work was still queued or running. */
  waitTimedOut: 6,
} as const;

const EXIT_CODES_HELP =
  "Exit codes: 0 ok, 1 error, 2 usage, 3 a person must act, 4 retryable error, 5 unknown outcome (a write may have run; read before retrying).";

const toCli = (name: string) => name.replaceAll("_", "-");
const fromCli = (name: string) => name.replaceAll("-", "_");

const entries = Object.values(agentSurfaceRegistry) as ReadonlyArray<AgentSurfaceRegistryEntry>;
const byResource = new Map<string, Array<AgentSurfaceRegistryEntry>>();
for (const entry of entries)
  if (entry.resource !== "surface")
    byResource.set(entry.resource, [...(byResource.get(entry.resource) ?? []), entry]);

const generatedVerbs = (resource: string) =>
  (byResource.get(resource) ?? [])
    .filter((entry) => !(OPERATOR_VERBS[resource] ?? []).includes(toCli(entry.verb)))
    .toSorted((a, b) => a.verb.localeCompare(b.verb));

/** For the operator command's own help: the registry verbs it does not define itself. */
export const generatedVerbsNote = (resource: string) => {
  const verbs = generatedVerbs(resource).map((entry) => toCli(entry.verb));
  return `Also from the registry: ${verbs.join(", ")}. See goat describe ${resource}.`;
};

const FIELD_HELP = [
  "  [json | -]          Arguments as one JSON object, or - to read it from stdin.",
  "  -f, --raw-field k=v Set argument k to the string v.",
  "  -F, --field k=v     Set k to true, false, null or an integer when v is one, @file or @- to read a string, else the string v.",
  "  --json              Print the result envelope as one JSON document.",
].join("\n");

const usageLine = (command: string, entry?: AgentSurfaceRegistryEntry) =>
  [
    `Usage: ${command} [json | -] [-f key=value] [-F key=value] [--json]`,
    ...(entry === undefined || entry.hostRoutable ? ["[--host <alias>]"] : []),
    ...(entry === undefined || entry.dryRun === "supported" ? ["[--dry-run]"] : []),
    "[--request-id <id>]",
  ].join(" ");

const OPERATION_WAIT_HELP =
  "goat operation wait exits by the work's state: 0 succeeded, 1 failed or cancelled, 3 waiting for a person, 5 unknown, 6 still queued or running when the wait ended.";

const entryHelp = (entry: AgentSurfaceRegistryEntry) =>
  [
    usageLine(`goat ${toCli(entry.resource)} ${toCli(entry.verb)}`, entry),
    "",
    entry.summary,
    "",
    entry.description,
    "",
    `Path: ${entry.path}   Tool: ${entry.name}   Effect: ${entry.effect}   Caller: ${entry.requires}`,
    `Host-routable: ${entry.hostRoutable ? "yes" : "no"}   Dry run: ${entry.dryRun}`,
    `Arguments: goat describe ${entry.path} prints the input schema.`,
    "",
    FIELD_HELP,
    ...(entry.hostRoutable
      ? ["  --host <alias>      Run it on that host; this GOAT routes the call."]
      : []),
    ...(entry.dryRun === "supported"
      ? ["  --dry-run           Return the plan and change nothing."]
      : []),
    "  --request-id <id>   Send it as clientRequestId so a retry is deduplicated where supported.",
    "",
    EXIT_CODES_HELP,
    ...(entry.path === "operation.wait" ? [OPERATION_WAIT_HELP] : []),
  ].join("\n");

const resourceHelp = (resource: string) => {
  const verbs = generatedVerbs(resource);
  const width = Math.max(...verbs.map((entry) => toCli(entry.verb).length));
  return [
    `Usage: goat ${toCli(resource)} <verb> [arguments] [--json]`,
    "",
    "Verbs:",
    ...verbs.map((entry) => `  ${toCli(entry.verb).padEnd(width)}  ${entry.summary}`),
    "",
    `goat ${toCli(resource)} <verb> --help describes one; goat describe ${resource} lists them with availability.`,
  ].join("\n");
};

const CALL_HELP = [
  usageLine("goat call <path>"),
  "",
  'Call one GOAT capability by path ("thread.read"), canonical name or tool name, through this',
  "environment's goat_call, with the same checks as a direct call.",
  "",
  FIELD_HELP,
  "  --host <alias>      Run it on that host; this GOAT routes the call.",
  "  --dry-run           Return the plan and change nothing, where the path supports it.",
  "  --request-id <id>   Send it as clientRequestId.",
  "",
  "Inside a GOAT thread it uses that thread's credential; otherwise the goat login session.",
  EXIT_CODES_HELP,
].join("\n");

const DESCRIBE_HELP = [
  "Usage: goat describe [path | resource] [--query <text>] [--json]",
  "",
  "Without a path: every resource and its verbs. With a resource: its paths. With a path: its",
  "input schema and whether this caller can use it now. --query ranks paths by text, within the",
  "resource when one is given.",
  "",
  EXIT_CODES_HELP,
].join("\n");

interface Parsed {
  readonly positionals: ReadonlyArray<string>;
  readonly fields: ReadonlyArray<readonly [string, unknown]>;
  readonly json: boolean;
  readonly help: boolean;
  readonly dryRun: boolean;
  readonly host?: string;
  readonly requestId?: string;
  readonly query?: string;
}

class UsageError {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

const INTEGER = /^-?(0|[1-9][0-9]*)$/;

const read = (input: InputReader, source: string) => {
  try {
    return source === "-" ? input.stdin() : input.file(source);
  } catch (cause) {
    throw new UsageError(
      `Could not read ${source === "-" ? "stdin" : source}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

/** gh api's -f/-F rules: -f is always a string; -F types the literals and reads @file. */
const typedValue = (value: string, input: InputReader): unknown => {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (INTEGER.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  if (value.startsWith("@")) return read(input, value.slice(1));
  return value;
};

const field = (raw: string, typed: boolean, input: InputReader): readonly [string, unknown] => {
  const separator = raw.indexOf("=");
  if (separator <= 0) throw new UsageError(`Expected key=value, got "${raw}".`);
  const value = raw.slice(separator + 1);
  return [raw.slice(0, separator), typed ? typedValue(value, input) : value];
};

const parseTokens = (
  tokens: ReadonlyArray<string>,
  input: InputReader,
  allow: { readonly fields: boolean; readonly query: boolean },
): Parsed => {
  const positionals: Array<string> = [];
  const fields: Array<readonly [string, unknown]> = [];
  let json = false;
  let help = false;
  let dryRun = false;
  let host: string | undefined;
  let requestId: string | undefined;
  let query: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = equals > 0 ? token.slice(0, equals) : token;
    const value = () => {
      if (equals > 0) return token.slice(equals + 1);
      const next = tokens[++index];
      if (next === undefined) throw new UsageError(`${flag} needs a value.`);
      return next;
    };
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (flag === "--help" || flag === "-h") help = true;
    else if (flag === "--json") json = true;
    else if (flag === "--dry-run" && allow.fields) dryRun = true;
    else if (flag === "--host" && allow.fields) host = value();
    else if (flag === "--request-id" && allow.fields) requestId = value();
    else if (flag === "--query" && allow.query) query = value();
    else if ((flag === "-f" || flag === "--raw-field") && allow.fields)
      fields.push(field(value(), false, input));
    else if ((flag === "-F" || flag === "--field") && allow.fields)
      fields.push(field(value(), true, input));
    else if (token.startsWith("-") && token !== "-") throw new UsageError(`Unknown flag ${flag}.`);
    else positionals.push(token);
  }
  return {
    positionals,
    fields,
    json,
    help,
    dryRun,
    ...(host === undefined ? {} : { host }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(query === undefined ? {} : { query }),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const baseArguments = (source: string | undefined, input: InputReader) => {
  if (source === undefined) return {};
  const text = source === "-" ? read(input, "-") : source;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError("Arguments must be valid JSON.");
  }
  if (!isRecord(parsed)) throw new UsageError("Arguments must be a JSON object.");
  return parsed;
};

/** The reserved flags, refused locally when the registry says the path cannot take them. */
const callArguments = (
  parsed: Parsed,
  base: string | undefined,
  entry: AgentSurfaceRegistryEntry | undefined,
  input: InputReader,
) => {
  if (parsed.host !== undefined && entry !== undefined && !entry.hostRoutable)
    throw new UsageError(`${entry.path} does not run on other hosts, so it takes no --host.`);
  if (parsed.dryRun && entry !== undefined && entry.dryRun !== "supported")
    throw new UsageError(`${entry.path} has no dry run.`);
  return {
    ...baseArguments(base, input),
    ...Object.fromEntries(parsed.fields),
    ...(parsed.host === undefined ? {} : { host: parsed.host }),
    ...(parsed.dryRun ? { dryRun: true } : {}),
    ...(parsed.requestId === undefined ? {} : { clientRequestId: parsed.requestId }),
  };
};

const call = (
  path: string,
  parsed: Parsed,
  base: string | undefined,
  entry: AgentSurfaceRegistryEntry | undefined,
  input: InputReader,
  json = parsed.json,
): AgentSurfaceInvocation => ({
  kind: "call",
  path,
  args: callArguments(parsed, base, entry, input),
  json,
  effect: entry?.effect ?? "destructive",
  format: "value",
  ...(entry === undefined ? {} : { entryPath: entry.path }),
});

const extraPositional = (parsed: Parsed, allowed: number) => {
  if (parsed.positionals.length > allowed)
    throw new UsageError(`Unexpected argument ${parsed.positionals[allowed]}.`);
};

const route = (
  argv: ReadonlyArray<string>,
  input: InputReader,
): AgentSurfaceInvocation | undefined => {
  const [command, ...rest] = argv;
  if (command === "call" || command === "acp-mcp-call") {
    const parsed = parseTokens(rest, input, { fields: true, query: false });
    if (parsed.help) return { kind: "help", text: CALL_HELP };
    const [path, base] = parsed.positionals;
    if (path === undefined) throw new UsageError(`${command} needs a path. ${CALL_HELP}`);
    extraPositional(parsed, 2);
    // acp-mcp-call's callers are agents reading stdout, so it always prints the envelope.
    return call(
      path,
      parsed,
      base,
      resolveAgentSurfaceEntry(path),
      input,
      parsed.json || command === "acp-mcp-call",
    );
  }
  if (command === "describe") {
    const parsed = parseTokens(rest, input, { fields: false, query: true });
    if (parsed.help) return { kind: "help", text: DESCRIBE_HELP };
    extraPositional(parsed, 1);
    const [path] = parsed.positionals;
    return {
      kind: "call",
      path: "surface.describe",
      args: {
        ...(path === undefined ? {} : { path }),
        ...(parsed.query === undefined ? {} : { query: parsed.query }),
      },
      json: parsed.json,
      effect: "read",
      format: "describe",
    };
  }
  if (command === undefined) return undefined;
  const resource = fromCli(command);
  if (!byResource.has(resource)) return undefined;
  const operator = OPERATOR_VERBS[resource];
  const [verbToken, ...tokens] = rest;
  if (verbToken === undefined || verbToken.startsWith("-")) {
    // An operator command keeps its own help, which lists the generated verbs too.
    if (operator !== undefined) return undefined;
    if (verbToken === undefined || verbToken === "--help" || verbToken === "-h")
      return { kind: "help", text: resourceHelp(resource) };
    throw new UsageError(
      `goat ${command} needs a verb before ${verbToken}.\n\n${resourceHelp(resource)}`,
    );
  }
  if (operator?.includes(verbToken)) return undefined;
  const entry = agentSurfaceRegistry[
    `${resource}.${fromCli(verbToken)}` as keyof typeof agentSurfaceRegistry
  ] as AgentSurfaceRegistryEntry | undefined;
  if (entry === undefined) {
    if (operator !== undefined) return undefined;
    throw new UsageError(`goat ${command} has no verb ${verbToken}.\n\n${resourceHelp(resource)}`);
  }
  const parsed = parseTokens(tokens, input, { fields: true, query: false });
  if (parsed.help) return { kind: "help", text: entryHelp(entry) };
  extraPositional(parsed, 1);
  const [positional] = parsed.positionals;
  // goat operation read|wait|cancel <id>: an operationId reads more naturally than JSON.
  if (entry.resource === "operation" && positional !== undefined && !/^\s*[{-]/u.test(positional))
    return call(
      entry.path,
      { ...parsed, fields: [["operationId", positional], ...parsed.fields] },
      undefined,
      entry,
      input,
    );
  return call(entry.path, parsed, positional, entry, input);
};

/** The command argv names, or undefined when it belongs to the operator CLI. */
export const agentSurfaceInvocation = (
  argv: ReadonlyArray<string>,
  input: InputReader,
): AgentSurfaceInvocation | undefined => {
  try {
    return route(argv, input);
  } catch (error) {
    if (error instanceof UsageError) return { kind: "usage", message: error.message };
    throw error;
  }
};

const WAIT_EXIT: Readonly<Record<string, number>> = {
  succeeded: EXIT.ok,
  failed: EXIT.error,
  cancelled: EXIT.error,
  waiting_human: EXIT.needsHuman,
  unknown: EXIT.unknownOutcome,
  queued: EXIT.waitTimedOut,
  running: EXIT.waitTimedOut,
};

/** operation.wait answers ok whatever became of the work, so its exit code reads the state. */
const operationWaitExit = (value: unknown): number => {
  const operation = isRecord(value) && isRecord(value.operation) ? value.operation : undefined;
  const state = typeof operation?.state === "string" ? operation.state : "unknown";
  return WAIT_EXIT[state] ?? EXIT.unknownOutcome;
};

export const exitCodeOf = (result: AgentSurfaceResult, entryPath?: string): number => {
  if (result.status === "ok")
    return entryPath === "operation.wait" ? operationWaitExit(result.value) : EXIT.ok;
  if (result.status === "needs_human") return EXIT.needsHuman;
  if (result.error.code === "unknown_outcome") return EXIT.unknownOutcome;
  return result.error.retryable ? EXIT.retryable : EXIT.error;
};

/** How far a call got before it failed, as AcpMcpBridgeError reports it. */
export interface CallFailure {
  /** connect: the session handshake, before goat_call was sent. dispatch: after. */
  readonly phase: "connect" | "dispatch";
  readonly kind: "transport" | "http" | "protocol" | "rpc";
  readonly status?: number | undefined;
  readonly rpcCode?: number | undefined;
  readonly message: string;
}

const failed = (
  code: "unauthenticated" | "invalid_request" | "unavailable" | "internal" | "unknown_outcome",
  reason: string,
  message: string,
  retryable: boolean,
  details?: unknown,
): AgentSurfaceResult => ({
  status: "error",
  error: { code, reason, message, retryable, ...(details === undefined ? {} : { details }) },
});

/** JSON-RPC codes the server answers with before any tool runs. */
const REFUSED_BEFORE_RUNNING = new Set([-32700, -32600, -32601, -32602]);

/**
 * A call that produced no envelope. Only an answer that proves nothing ran is final; a write
 * whose answer was lost is unknown_outcome, never retryable, whatever --request-id says.
 */
export const failureResult = (failure: CallFailure, effect: CallEffect): AgentSurfaceResult => {
  if (failure.kind === "http" && (failure.status === 401 || failure.status === 403))
    return failed("unauthenticated", `http_${failure.status}`, failure.message, false);
  if (failure.phase === "connect") {
    if (failure.kind === "transport")
      return failed("unavailable", "unreachable", failure.message, true);
    if (failure.kind === "http" && (failure.status === 429 || (failure.status ?? 0) >= 500))
      return failed("unavailable", `http_${failure.status}`, failure.message, true);
    return failed("internal", `handshake_${failure.kind}`, failure.message, false);
  }
  if (
    failure.kind === "rpc" &&
    failure.rpcCode !== undefined &&
    REFUSED_BEFORE_RUNNING.has(failure.rpcCode)
  )
    return failed("invalid_request", `rpc_${failure.rpcCode}`, failure.message, false);
  if (effect === "read")
    return failed("unavailable", `answer_lost_${failure.kind}`, failure.message, true);
  return failed("unknown_outcome", `answer_lost_${failure.kind}`, failure.message, false, {
    reconcile: "Read the target's state before calling it again.",
  });
};

const decodeEnvelope = Schema.decodeUnknownOption(AgentSurfaceResult);

/**
 * goat_call always answers with an envelope in structuredContent. An error result without one
 * comes from /mcp itself, which refuses an unresolvable credential that way before any tool
 * runs (McpHttpServer refuseCredential). Anything else is an unusable answer.
 */
export const toolResultEnvelope = (raw: unknown): Option.Option<AgentSurfaceResult> => {
  if (!isRecord(raw)) return Option.none();
  const envelope = decodeEnvelope(raw.structuredContent);
  if (Option.isSome(envelope) || raw.isError !== true) return envelope;
  const text = Array.isArray(raw.content)
    ? raw.content
        .flatMap((block) => (isRecord(block) && typeof block.text === "string" ? [block.text] : []))
        .join("\n")
    : "";
  return Option.some(
    failed("unauthenticated", "credential_refused", text || "The server refused the call.", false),
  );
};
