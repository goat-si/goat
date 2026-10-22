// The bridge relays opaque JSON-RPC lines verbatim; schema-decoding foreign
// payloads here would reject traffic it must pass through untouched.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeReadline from "node:readline";

import { discardResponseBody, responsePayloads } from "@goat/shared/mcpResponsePayloads";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

/**
 * ACP agents must support stdio MCP servers, while optional http/sse support is
 * unevenly implemented.
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

type FetchImplementation = (url: string, init?: RequestInit) => Promise<Response>;

/** A sender bound to one HTTP MCP session, and the request that ends that session. */
function makeAcpMcpSender(options: {
  readonly endpoint: string;
  readonly authorization: string;
  readonly fetchImplementation?: FetchImplementation | undefined;
}) {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  const headers = () => ({
    accept: "application/json, text/event-stream",
    authorization: options.authorization,
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
  });

  const send = Effect.fn("AcpMcpStdioBridge.send")(function* (
    message: unknown,
  ): Effect.fn.Return<ReadonlyArray<unknown>, AcpMcpBridgeError> {
    const response = yield* Effect.tryPromise({
      // Interrupting the request (a caller's timeout) aborts the HTTP call.
      try: (signal) =>
        fetchImplementation(options.endpoint, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", ...headers() },
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

  const terminate = Effect.suspend(() =>
    sessionId === null
      ? Effect.void
      : Effect.tryPromise(() =>
          fetchImplementation(options.endpoint, { method: "DELETE", headers: headers() }),
        ).pipe(Effect.flatMap(discardResponseBody), Effect.ignore),
  );

  return { send, terminate };
}

const initializeAcpMcpSession = Effect.fn("AcpMcpStdioBridge.initialize")(function* (
  send: ReturnType<typeof makeAcpMcpSender>["send"],
  clientName: string,
) {
  const initializeId = "t3-acp-cli-initialize";
  const initialized = yield* send({
    jsonrpc: "2.0",
    id: initializeId,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: "0.0.0" },
    },
  });
  const initializeResponse = initialized.find((entry) => asEnvelope(entry)?.id === initializeId);
  if (initializeResponse === undefined || asEnvelope(initializeResponse)?.error !== undefined) {
    return yield* Effect.fail(
      new AcpMcpBridgeError("GOAT MCP endpoint rejected initialization.", { kind: "protocol" }),
    );
  }
  yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
});

/** Opens an authenticated HTTP MCP session and returns a sender bound to it. */
function openAcpMcpSession(options: {
  readonly endpoint: string;
  readonly authorization: string;
  readonly fetchImplementation?: FetchImplementation | undefined;
}) {
  return Effect.gen(function* () {
    const { send } = makeAcpMcpSender(options);
    yield* initializeAcpMcpSession(send, "t3-code-acp-cli");
    return send;
  });
}

export interface McpToolSessionOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly clientName: string;
  readonly fetchImplementation?: FetchImplementation;
}

export interface McpToolSession {
  /** Resolves to the JSON-RPC `result` of `tools/call`, a `CallToolResult`. */
  readonly call: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, AcpMcpBridgeError>;
}

/** One initialized MCP session over GOAT's HTTP endpoint, ended when the scope closes. */
export const mcpToolSession = Effect.fn("AcpMcpStdioBridge.mcpToolSession")(function* (
  options: McpToolSessionOptions,
) {
  const { send, terminate } = makeAcpMcpSender(options);
  // Registered before the handshake so a session the server opened is ended
  // even when the handshake fails.
  yield* Effect.addFinalizer(() => terminate);
  yield* initializeAcpMcpSession(send, options.clientName);
  let nextId = 0;
  return {
    call: (tool, args) =>
      Effect.gen(function* () {
        const id = `t3-cli-${nextId++}`;
        const responses = yield* send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: tool, arguments: args },
        });
        return yield* requestResult(responses, id, "GOAT MCP tool call");
      }),
  } satisfies McpToolSession;
});

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
  /** Reject incomplete catalogs when the caller uses them for admission. */
  readonly strict?: boolean;
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
    if (
      options.strict === true &&
      (!Array.isArray(tools) ||
        tools.some((tool) => {
          if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return true;
          const entry = tool as { readonly name?: unknown; readonly inputSchema?: unknown };
          if (typeof entry.name !== "string" || entry.name.length === 0) return true;
          if (
            typeof entry.inputSchema !== "object" ||
            entry.inputSchema === null ||
            Array.isArray(entry.inputSchema)
          )
            return true;
          const schema = entry.inputSchema as {
            readonly type?: unknown;
            readonly properties?: unknown;
          };
          return (
            schema.type !== "object" ||
            (schema.properties !== undefined &&
              (typeof schema.properties !== "object" ||
                schema.properties === null ||
                Array.isArray(schema.properties)))
          );
        }))
    )
      return yield* Effect.fail(
        new AcpMcpBridgeError("GOAT MCP returned a malformed tool catalog.", {
          kind: "protocol",
        }),
      );
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool): ReadonlyArray<AcpMcpListedTool> => {
      // A remote can return anything here; skip entries that are not objects.
      if (typeof tool !== "object" || tool === null) return [];
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
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;
    const running = new Set<Fiber.Fiber<void>>();

    const writeMessage = (message: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        options.output.write(`${JSON.stringify(message)}\n`);
      });

    const handleServerPayload = Effect.fn("AcpMcpStdioBridge.handleServerPayload")(function* (
      payload: unknown,
    ): Effect.fn.Return<void> {
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

    const forward: (line: string, envelope: JsonRpcEnvelope) => Effect.Effect<void> = Effect.fn(
      "AcpMcpStdioBridge.forward",
    )(
      function* (line: string, envelope: JsonRpcEnvelope) {
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
      },
      (effect, _line, envelope) =>
        effect.pipe(
          Effect.catchCause((cause) => {
            if (envelope.id === undefined) return Effect.void;
            const error = Cause.squash(cause);
            return respondWithError(
              envelope.id,
              `GOAT MCP bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
        ),
    );

    // Only session establishment is ordered; client responses to
    // server-initiated SSE requests must bypass the barrier or they would
    // deadlock the still-open HTTP exchange, and normal MCP calls stay
    // concurrent after initialization.
    let sessionBarrier: Effect.Effect<void> = Effect.void;
    let sessionBarrierPending = false;

    const launch = Effect.fn("AcpMcpStdioBridge.launch")(function* (
      task: Effect.Effect<void>,
    ): Effect.fn.Return<void> {
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

    const dispatch = Effect.fn("AcpMcpStdioBridge.dispatch")(function* (
      line: string,
    ): Effect.fn.Return<void> {
      if (line.trim().length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return yield* respondWithError(null, "Parse error", -32700);
      }
      const envelope = asEnvelope(parsed);
      if (envelope === null) return;
      const isResponse = envelope.id !== undefined && ("result" in envelope || "error" in envelope);
      const isSessionHandshake =
        envelope.method === "initialize" || envelope.method === "notifications/initialized";
      if (isResponse) {
        return yield* launch(forward(line, envelope));
      }
      if (isSessionHandshake) {
        const prior = sessionBarrier;
        const fiber = yield* Effect.forkChild(prior.pipe(Effect.andThen(forward(line, envelope))));
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
 * Kept free of heavy imports: these commands run on the ACP first-message
 * critical path.
 */
export async function runAcpMcpCliFastPath(
  command: "acp-mcp-bridge" | "acp-mcp-call",
  args: ReadonlyArray<string>,
): Promise<void> {
  const endpoint = process.env.GOAT_ACP_MCP_ENDPOINT;
  const authorization = process.env.GOAT_ACP_MCP_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined) {
    process.stderr.write(
      `${command} requires GOAT_ACP_MCP_ENDPOINT and GOAT_ACP_MCP_AUTHORIZATION.\n`,
    );
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
