// @effect-diagnostics globalFetch:off -- the external generator uses Node HTTP outside the server's Effect runtime.
import * as NodePerfHooks from "node:perf_hooks";
import {
  AuthWebSocketTicketResult,
  CommandId,
  ThreadId,
  WsRpcGroup,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { createThread, replayThreadId } from "./serverSeed.ts";
import { distribution, type OperationMeasurements } from "./report.ts";

const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(AuthWebSocketTicketResult));

async function checkedFetch(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Fixture HTTP request failed (${response.status})`);
  return response;
}

export async function runLoad(origin: string, credential: string, rounds: number) {
  const latencies = new Map<string, number[]>();
  const operations: Record<string, OperationMeasurements> = {};
  const redact = (error: string) => error.replaceAll(credential, "[credential]");
  const measure = Effect.fn("benchmark.measure")(function* <A, E, R>(
    kind: string,
    action: Effect.Effect<A, E, R>,
  ) {
    const counters = (operations[kind] ??= { offered: 0, completed: 0, failed: 0, errors: [] });
    counters.offered++;
    const start = NodePerfHooks.performance.now();
    return yield* action.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          const samples = latencies.get(kind) ?? [];
          samples.push(NodePerfHooks.performance.now() - start);
          latencies.set(kind, samples);
          if (Exit.isFailure(exit)) {
            counters.failed++;
            counters.errors.push(redact(Cause.pretty(exit.cause)));
          } else {
            counters.completed++;
          }
        }),
      ),
    );
  });
  let error: string | undefined;
  try {
    const login = await checkedFetch(`${origin}/api/auth/browser-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Fixture authentication did not issue a cookie");
    const ticketResponse = await checkedFetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { cookie },
    });
    const { ticket } = decodeTicket(await ticketResponse.json());
    const socket = Socket.layerWebSocket(
      `${origin.replace("http:", "ws:")}/ws?wsTicket=${encodeURIComponent(Redacted.value(ticket))}&${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`,
    ).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, (url) => new WebSocket(url))));
    const protocol = RpcClient.layerProtocolSocket({
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }).pipe(Layer.provide(socket), Layer.provide(RpcSerialization.layerJson));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(WsRpcGroup);
          yield* measure("config", client["server.getConfig"]({}));
          const replay = yield* client["orchestration.getThreadProjection"]({
            threadId: replayThreadId,
          });
          if (!replay.messages.some((message) => message.text === "fixture simple ok")) {
            return yield* Effect.die(new Error("Normal server could not read the replayed turn"));
          }
          for (let round = 0; round < rounds; round++) {
            const threadId = ThreadId.make(`benchmark-load-${round}`);
            yield* measure(
              "create",
              client["orchestration.dispatchCommand"](createThread(threadId)),
            );
            // A bounded cohort overlaps read traffic with mutation/attachment work in the real server.
            yield* Effect.all(
              [
                measure(
                  "search",
                  client["orchestration.searchThreads"]({
                    query: round % 2 === 0 ? "fixture" : "missingbenchmarkneedle",
                  }),
                ),
                measure(
                  "projection",
                  client["orchestration.getThreadProjection"]({ threadId: replayThreadId }),
                ),
                measure(
                  "settle",
                  client["orchestration.dispatchCommand"]({
                    type: "thread.settle",
                    commandId: CommandId.make(`settle:${round}`),
                    threadId,
                  }),
                ),
                measure(
                  "attachment",
                  Effect.gen(function* () {
                    const body = `Generated benchmark attachment ${round}\n`.repeat(128);
                    const upload = yield* client["attachments.createUploadUrl"]({
                      type: "file",
                      name: `benchmark-${round}.txt`,
                      mimeType: "text/plain",
                      sizeBytes: Buffer.byteLength(body),
                    });
                    yield* Effect.tryPromise(() =>
                      checkedFetch(new URL(upload.relativeUrl, origin).href, {
                        method: "POST",
                        headers: { "content-type": "text/plain" },
                        body,
                      }),
                    );
                  }),
                ),
              ],
              { concurrency: 4 },
            );
            const settled = yield* client["orchestration.getThreadProjection"]({ threadId });
            if (settled.thread.settledOverride !== "settled")
              return yield* Effect.die(new Error("Settlement was not persisted"));
          }
        }).pipe(Effect.provide(protocol), Effect.timeout("2 minutes")),
      ),
    );
  } catch (cause) {
    error = redact(String(cause));
  }
  return {
    error,
    operations,
    latencies: Object.fromEntries(
      [...latencies].map(([kind, samples]) => [kind, distribution(samples)]),
    ),
  };
}
