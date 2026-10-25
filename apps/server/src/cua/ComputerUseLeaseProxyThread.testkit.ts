// @effect-diagnostics preferSchemaOverJson:off -- The fixture speaks MCP JSON-RPC over queues.
import {
  type ComputerUseCallAdmission,
  type ComputerUseCallReservation,
  type ComputerUseLeaseThreadUpdate,
  type ComputerUseLeaseUpdate,
} from "@goat/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { runThreadLeaseProxy } from "./ComputerUseLeaseProxyThread.ts";
import type { AgentInputReport } from "./agentInputReports.ts";

export const request = (id: number, method: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
export const initialize = request(100, "initialize");
export const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
export const serverInfo = {
  protocolVersion: "2025-06-18",
  serverInfo: { name: "fixture-driver", version: "1" },
  capabilities: { tools: {} },
};
export const tools = { tools: [{ name: "get_guide", inputSchema: { type: "object" } }] };
export const snapshot = (controlId: string, expiresAt = "1970-01-01T00:10:00.000Z") => ({
  state: "active" as const,
  controlId,
  expiresAt,
});

export const threadHarness = Effect.fn("ThreadProxyTest.harness")(function* (
  options: {
    readonly killGate?: Deferred.Deferred<void>;
    readonly targetGate?: Deferred.Deferred<void>;
    readonly agentGate?: Deferred.Deferred<void>;
    readonly toolsAt?: (index: number) => typeof tools;
  } = {},
) {
  const input = yield* Queue.unbounded<string, Cause.Done>();
  const updates = yield* Queue.unbounded<ComputerUseLeaseThreadUpdate, Cause.Done | string>();
  const output = yield* Queue.unbounded<string>();
  const taken = yield* Queue.unbounded<ComputerUseLeaseThreadUpdate>();
  const applied = yield* Queue.unbounded<ComputerUseLeaseUpdate>();
  const started = yield* Queue.unbounded<Effect.Success<ReturnType<typeof makeDriver>>>();
  const closed = yield* Queue.unbounded<ComputerUseCallReservation>();
  const target = yield* Queue.unbounded<string>();
  const agents = yield* Queue.unbounded<{ controlId: string; report: AgentInputReport }>();
  const completedAgents = yield* Queue.unbounded<{ controlId: string; report: AgentInputReport }>();
  const log: Array<string> = [];
  let drivers = 0;
  const makeDriver = Effect.fn("ThreadProxyTest.makeDriver")(function* (index: number) {
    return {
      index,
      sent: yield* Queue.unbounded<string>(),
      replies: yield* Queue.unbounded<string, Cause.Done>(),
      killed: yield* Deferred.make<void>(),
    };
  });
  const startDriver = Effect.gen(function* () {
    const d = yield* makeDriver(drivers++);
    log.push(`start ${d.index}`);
    yield* Queue.offer(started, d);
    return {
      send: (line: string) => {
        const m = JSON.parse(line) as { id?: number | string; method?: string };
        if (m.method === "initialize" || m.method === "tools/list" || m.method === "ping")
          return Queue.offer(
            d.replies,
            JSON.stringify({
              jsonrpc: "2.0",
              id: m.id,
              result:
                m.method === "initialize"
                  ? serverInfo
                  : m.method === "tools/list"
                    ? (options.toolsAt?.(d.index) ?? tools)
                    : {},
            }),
          ).pipe(Effect.asVoid);
        return m.method === "notifications/initialized"
          ? Effect.void
          : Queue.offer(d.sent, line).pipe(Effect.asVoid);
      },
      lines: Stream.fromQueue(d.replies),
      kill: Deferred.succeed(d.killed, undefined).pipe(
        Effect.andThen(
          options.killGate === undefined ? Effect.void : Deferred.await(options.killGate),
        ),
        Effect.andThen(Effect.sync(() => void log.push(`closed ${d.index}`))),
        Effect.andThen(Queue.end(d.replies)),
      ),
    };
  });
  const proxy = yield* runThreadLeaseProxy({
    connectionId: "thread-proxy:test",
    bundleIds: true,
    input: Stream.fromQueue(input),
    output: (line) => Queue.offer(output, line).pipe(Effect.asVoid),
    leaseUpdates: Stream.fromQueue(updates),
    onThreadUpdate: (u) => Queue.offer(taken, u).pipe(Effect.asVoid),
    onLeaseUpdateApplied: (u) => Queue.offer(applied, u).pipe(Effect.asVoid),
    startDriver,
    revokeSessions: () => Effect.void,
    reservation: (call) => {
      if (call.action === "close") {
        log.push(`close ${call.controlId}`);
        return Queue.offer(closed, call).pipe(
          Effect.as<ComputerUseCallAdmission>({ status: "released" }),
        );
      }
      return Effect.succeed<ComputerUseCallAdmission>(
        call.action === "reserve"
          ? { status: "admitted", reservationId: `ticket:${call.callId}` }
          : call.action === "validate"
            ? {
                status: "admitted",
                reservationId: call.reservationId,
                permissions: { validUntilMillis: 3_600_000 },
              }
            : { status: "released" },
      );
    },
    reports: (controlId) => ({
      onTarget: () =>
        Queue.offer(target, controlId).pipe(
          Effect.andThen(
            options.targetGate === undefined ? Effect.void : Deferred.await(options.targetGate),
          ),
          Effect.as(true),
        ),
      onAgentInput: (report) =>
        Queue.offer(agents, { controlId, report }).pipe(
          Effect.andThen(
            report.state === "start" && options.agentGate !== undefined
              ? Deferred.await(options.agentGate)
              : Effect.void,
          ),
          Effect.andThen(Queue.offer(completedAgents, { controlId, report })),
          Effect.asVoid,
          Effect.uninterruptible,
        ),
    }),
  }).pipe(Effect.scoped, Effect.forkChild);
  return {
    send: (line: string) => Queue.offer(input, line),
    push: (update: ComputerUseLeaseThreadUpdate) =>
      Queue.offer(updates, update).pipe(Effect.andThen(Queue.take(taken))),
    next: Queue.take(output).pipe(
      Effect.map(
        (line) =>
          JSON.parse(line) as {
            id: number | string;
            method?: string;
            params?: Record<string, unknown>;
            result?: { [key: string]: unknown; structuredContent?: Record<string, unknown> };
            error?: unknown;
          },
      ),
    ),
    started: Queue.take(started),
    applied: Queue.take(applied),
    closed: Queue.take(closed),
    target: Queue.take(target),
    agents: Queue.take(agents),
    completedAgent: Queue.take(completedAgents),
    streamEnd: Queue.end(updates),
    streamFail: Queue.fail(updates, "disconnected"),
    close: Queue.end(input),
    proxy,
    log,
  };
});
