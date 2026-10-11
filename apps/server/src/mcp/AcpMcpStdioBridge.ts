// The bridge relays opaque JSON-RPC lines verbatim; schema-decoding foreign
// payloads here would reject traffic it must pass through untouched.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeReadline from "node:readline";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";

/**
 * Stdio-to-HTTP bridge for T3's MCP endpoint.
 *
 * ACP agents must support stdio MCP servers, while optional http/sse support
 * is unevenly implemented. `t3 acp-mcp-bridge` runs as the stdio MCP server an
 * ACP agent spawns and forwards each JSON-RPC line to T3's authenticated
 * streamable-HTTP endpoint: single JSON responses and SSE streams are written
 * back as newline-delimited JSON-RPC, notification acknowledgements (202/204)
 * produce no output, and the `mcp-session-id` / negotiated protocol version
 * are replayed on subsequent requests.
 *
 * This entry sits on the ACP first-message critical path (bin.ts fast-paths
 * it before the CLI graph), so it imports only effect core modules; keep the
 * import list lean when changing it.
 */

/**
 * transport: the endpoint could not be reached or the connection dropped.
 * http: it answered with a non-2xx status. protocol: it answered with
 * something that is not a usable MCP response. rpc: it returned a JSON-RPC
 * error, such as an unknown tool.
 */
export type AcpMcpBridgeErrorKind = "transport" | "http" | "protocol" | "rpc";

export class AcpMcpBridgeError extends Error {
  readonly _tag = "AcpMcpBridgeError";
  readonly kind: AcpMcpBridgeErrorKind;
  readonly status: number | undefined;
  constructor(
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly kind?: AcpMcpBridgeErrorKind;
      readonly status?: number;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.kind = options?.kind ?? "transport";
    this.status = options?.status;
  }
}

const bridgeError = (cause: unknown): AcpMcpBridgeError =>
  cause instanceof AcpMcpBridgeError
    ? cause
    : new AcpMcpBridgeError(cause instanceof Error ? cause.message : String(cause), { cause });

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AcpMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

export interface AcpMcpToolCallOptions<E = never, R = never> {
  readonly endpoint: string;
  readonly authorization: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * Runs after the session handshake, right before the tool request is sent.
   * A failure here sends nothing. Callers use it to re-check authority that
   * may have changed while the handshake ran.
   */
  readonly beforeToolCall?: Effect.Effect<void, E, R>;
}

/** Opens an authenticated HTTP MCP session and returns a sender bound to it. */
function openAcpMcpSession(options: {
  readonly endpoint: string;
  readonly authorization: string;
  readonly fetchImplementation?:
    | ((url: string, init?: RequestInit) => Promise<Response>)
    | undefined;
}) {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Effect.gen(function* () {
    // The bridge is single-fibered at creation time; concurrent sends only
    // read these after the sequential handshake, so plain locals suffice.
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;

    const send = (message: unknown): Effect.Effect<ReadonlyArray<unknown>, AcpMcpBridgeError> =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImplementation(options.endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: options.authorization,
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: JSON.stringify(message),
            }),
          catch: bridgeError,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          yield* discardResponseBody(response);
          return yield* Effect.fail(
            new AcpMcpBridgeError(`GOAT MCP endpoint responded with HTTP ${response.status}.`, {
              kind: "http",
              status: response.status,
            }),
          );
        }
        const payloads = yield* Stream.runCollect(responsePayloads(response, bridgeError));
        for (const payload of payloads) {
          protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
        }
        return payloads;
      });

    const initializeId = "t3-acp-cli-initialize";
    const initialized = yield* send({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-code-acp-cli", version: "0.0.0" },
      },
    });
    const initializeResponse = initialized.find((entry) => asEnvelope(entry)?.id === initializeId);
    if (initializeResponse === undefined || asEnvelope(initializeResponse)?.error !== undefined) {
      return yield* Effect.fail(
        new AcpMcpBridgeError("GOAT MCP endpoint rejected initialization.", { kind: "protocol" }),
      );
    }
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return send;
  });
}

/** The single response to a request sent on an MCP session, or a protocol error. */
function requestResult(
  responses: ReadonlyArray<unknown>,
  id: string,
  describe: string,
): Effect.Effect<unknown, AcpMcpBridgeError> {
  const envelope = asEnvelope(responses.find((entry) => asEnvelope(entry)?.id === id));
  if (envelope === null || envelope.error !== undefined) {
    return Effect.fail(
      new AcpMcpBridgeError(
        `${describe} failed${envelope?.error === undefined ? "." : `: ${JSON.stringify(envelope.error)}`}`,
        { kind: envelope === null ? "protocol" : "rpc" },
      ),
    );
  }
  return Effect.succeed(envelope.result);
}

/**
 * Call one MCP tool through a fresh authenticated HTTP session.
 *
 * This is the terminal fallback for ACP agents that accept `mcpServers` in
 * `session/new` but fail to expose those tools to their model. Compliant ACP
 * agents continue to use the stdio bridge above.
 */
export function callAcpMcpTool<E = never, R = never>(
  options: AcpMcpToolCallOptions<E, R>,
): Effect.Effect<unknown, AcpMcpBridgeError | E, R> {
  return Effect.gen(function* () {
    const send = yield* openAcpMcpSession(options);
    if (options.beforeToolCall !== undefined) yield* options.beforeToolCall;

    const callId = "t3-acp-cli-tool-call";
    const responses = yield* send({
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: { name: options.tool, arguments: options.arguments },
    });
    return yield* requestResult(responses, callId, "GOAT MCP tool call");
  });
}

/** A tool as `tools/list` describes it: its name and the arguments it declares. */
export interface AcpMcpListedTool {
  readonly name: string;
  readonly argumentNames: ReadonlyArray<string>;
}

/**
 * List the tools an MCP endpoint offers, with the top-level arguments each declares.
 * Callers use it to send an optional argument only to servers that understand it.
 */
export function listAcpMcpTools(options: {
  readonly endpoint: string;
  readonly authorization: string;
  readonly fetchImplementation?:
    | ((url: string, init?: RequestInit) => Promise<Response>)
    | undefined;
}): Effect.Effect<ReadonlyArray<AcpMcpListedTool>, AcpMcpBridgeError> {
  return Effect.gen(function* () {
    const send = yield* openAcpMcpSession(options);
    const listId = "t3-acp-cli-tools-list";
    const responses = yield* send({ jsonrpc: "2.0", id: listId, method: "tools/list" });
    const result = yield* requestResult(responses, listId, "GOAT MCP tool listing");
    const tools = (result as { readonly tools?: unknown } | null)?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool): ReadonlyArray<AcpMcpListedTool> => {
      const entry = tool as {
        readonly name?: unknown;
        readonly inputSchema?: { readonly properties?: unknown };
      };
      if (typeof entry.name !== "string") return [];
      const properties = entry.inputSchema?.properties;
      return [
        {
          name: entry.name,
          argumentNames:
            typeof properties === "object" && properties !== null ? Object.keys(properties) : [],
        },
      ];
    });
  });
}

export function runAcpMcpStdioBridge(options: AcpMcpStdioBridgeOptions): Effect.Effect<void> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Effect.gen(function* () {
    // Dispatch happens synchronously on the single stream fiber, so plain
    // locals carry the shared session state; forwards mutate them in
    // completion order exactly like the wire does.
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;
    const running = new Set<Fiber.Fiber<void>>();

    const writeMessage = (message: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        options.output.write(`${JSON.stringify(message)}\n`);
      });

    const handleServerPayload = (payload: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const entry of Array.isArray(payload) ? payload : [payload]) {
          protocolVersion = protocolVersionOf(entry) ?? protocolVersion;
          yield* writeMessage(entry);
        }
      });

    const respondWithError = (
      requestId: unknown,
      message: string,
      code = -32603,
    ): Effect.Effect<void> =>
      writeMessage({
        jsonrpc: "2.0",
        id: requestId ?? null,
        error: { code, message },
      });

    const forward = (line: string, envelope: JsonRpcEnvelope): Effect.Effect<void> =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImplementation(options.endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: options.authorization,
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: line,
            }),
          catch: bridgeError,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          if (envelope.id !== undefined) {
            yield* respondWithError(
              envelope.id,
              `GOAT MCP endpoint responded with HTTP ${response.status}.`,
            );
          }
          return yield* discardResponseBody(response);
        }
        yield* Stream.runForEach(responsePayloads(response, bridgeError), handleServerPayload);
      }).pipe(
        Effect.catchCause((cause) => {
          if (envelope.id === undefined) return Effect.void;
          const error = Cause.squash(cause);
          return respondWithError(
            envelope.id,
            `GOAT MCP bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      );

    // Only session establishment is ordered; client responses to
    // server-initiated SSE requests must bypass the barrier or they would
    // deadlock the still-open HTTP exchange, and normal MCP calls stay
    // concurrent after initialization.
    let sessionBarrier: Effect.Effect<void> = Effect.void;
    let sessionBarrierPending = false;

    const launch = (task: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(task);
        running.add(fiber);
        yield* Effect.forkChild(
          Fiber.await(fiber).pipe(
            Effect.andThen(
              Effect.sync(() => {
                running.delete(fiber);
              }),
            ),
          ),
        );
      });

    const dispatch = (line: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (line.trim().length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return yield* respondWithError(null, "Parse error", -32700);
        }
        const envelope = asEnvelope(parsed);
        if (envelope === null) return;
        const isResponse =
          envelope.id !== undefined && ("result" in envelope || "error" in envelope);
        const isSessionHandshake =
          envelope.method === "initialize" || envelope.method === "notifications/initialized";
        if (isResponse) {
          return yield* launch(forward(line, envelope));
        }
        if (isSessionHandshake) {
          const prior = sessionBarrier;
          const fiber = yield* Effect.forkChild(
            prior.pipe(Effect.andThen(forward(line, envelope))),
          );
          running.add(fiber);
          const barrier = Fiber.await(fiber).pipe(Effect.asVoid);
          sessionBarrier = barrier;
          sessionBarrierPending = true;
          yield* Effect.forkChild(
            Fiber.await(fiber).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  running.delete(fiber);
                  if (sessionBarrier === barrier) sessionBarrierPending = false;
                }),
              ),
            ),
          );
          return;
        }
        const task = sessionBarrierPending
          ? sessionBarrier.pipe(Effect.andThen(forward(line, envelope)))
          : forward(line, envelope);
        return yield* launch(task);
      });

    const reader = NodeReadline.createInterface({ input: options.input });
    yield* Stream.runForEach(Stream.fromAsyncIterable(reader, bridgeError), dispatch).pipe(
      Effect.catchCause(() => Effect.void),
    );
    yield* Fiber.awaitAll(running);
  });
}

/**
 * Argv runner for `t3 acp-mcp-bridge` and `t3 acp-mcp-call`, shared by the
 * fast-path dispatch in bin.ts and the full CLI's command handlers. Kept free
 * of heavy imports: these commands run on the ACP first-message critical path.
 */
export async function runAcpMcpCliFastPath(
  command: "acp-mcp-bridge" | "acp-mcp-call",
  args: ReadonlyArray<string>,
): Promise<void> {
  const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
  const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined) {
    process.stderr.write(`${command} requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.\n`);
    process.exitCode = 2;
    return;
  }
  if (command === "acp-mcp-bridge") {
    await Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint,
        authorization,
        input: process.stdin,
        output: process.stdout,
      }),
    );
    return;
  }
  const [tool, argumentsJson] = args;
  if (tool === undefined || argumentsJson === undefined) {
    process.stderr.write("acp-mcp-call requires <tool> and <arguments-json>.\n");
    process.exitCode = 2;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    process.stderr.write("acp-mcp-call arguments must be valid JSON.\n");
    process.exitCode = 2;
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("acp-mcp-call arguments must be a JSON object.\n");
    process.exitCode = 2;
    return;
  }
  const result = await Effect.runPromise(
    callAcpMcpTool({
      endpoint,
      authorization,
      tool,
      arguments: parsed as Record<string, unknown>,
    }),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
