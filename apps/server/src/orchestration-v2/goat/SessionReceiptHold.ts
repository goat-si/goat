import {
  isGoatBotSessionThreadId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  ThreadId,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import * as SessionReceiptGate from "./SessionReceiptGate.ts";

type Input = Parameters<
  ProviderEventIngestor.ProviderEventIngestorV2["Service"]["ingestNormalized"]
>[0] & { readonly receiptAttemptId?: RunAttemptId };
type Held = { readonly input: Input; durable: boolean };
type Buffer = {
  readonly threadId: ThreadId;
  readonly events: Held[];
  owner: SessionReceiptGate.ReceiptOwnership | undefined;
};
const artifact = (event: Input["event"]) =>
  event.type === "runtime_request.updated" ||
  (event.type === "node.updated" &&
    (event.node.kind === "approval_request" || event.node.kind === "user_input_request")) ||
  (event.type === "turn_item.updated" &&
    (event.turnItem.type === "approval_request" || event.turnItem.type === "user_input_request"));
const nodeIdOf = (event: Input["event"]) =>
  event.type === "node.updated"
    ? event.node.id
    : event.type === "turn_item.updated"
      ? event.turnItem.nodeId
      : event.type === "runtime_request.updated"
        ? event.runtimeRequest.nodeId
        : undefined;
const messageArtifact = (event: Input["event"]) =>
  (event.type === "runtime_request.updated" &&
    event.runtimeRequest.responseCapability.type === "message") ||
  (event.type === "turn_item.updated" &&
    event.turnItem.type === "user_input_request" &&
    event.turnItem.responseMode === "message");
const stored = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      providerSessionId: ProviderSessionId,
      providerInstanceId: ProviderInstanceId,
      threadId: ThreadId,
      runId: RunId,
      nodeId: Schema.optionalKey(NodeId),
      event: ProviderAdapter.ProviderAdapterV2Event,
    }),
  ),
);
const encode = Schema.encodeSync(stored);
const decode = Schema.decodeUnknownSync(stored);

export class SessionReceiptHold extends Context.Service<
  SessionReceiptHold,
  {
    readonly ingestNormalized: (
      input: Input,
    ) => ReturnType<ProviderEventIngestor.ProviderEventIngestorV2["Service"]["ingestNormalized"]>;
    readonly release: (
      runId: RunId,
    ) => Effect.Effect<void, ProviderEventIngestor.ProviderEventIngestorV2Error>;
  }
>()("goat/orchestration-v2/goat/SessionReceiptHold") {}

const make = Effect.gen(function* () {
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  const sql = yield* SqlClient.SqlClient;
  const gate = yield* SessionReceiptGate.SessionReceiptGate;
  const lock = yield* Semaphore.make(1);
  const buffers = new Map<RunId, Buffer>();
  const publishError = (input: Input, cause: unknown) =>
    new ProviderEventIngestor.ProviderEventPublishError({
      providerSessionId: input.providerSessionId,
      eventCount: 1,
      cause,
    });
  const removeRows = (runId: RunId) =>
    sql`DELETE FROM session_held_provider_events WHERE run_id = ${runId}`.pipe(Effect.asVoid);
  const stage = Effect.fn("SessionReceiptHold.stage")(function* (
    runId: RunId,
    buffer: Buffer,
    current: Input,
  ) {
    const state = yield* gate.inspect(buffer.threadId, runId);
    if (state.state !== "held" && state.state !== "settled")
      return yield* new ProviderEventIngestor.ProviderEventPublishError({
        providerSessionId: current.providerSessionId,
        eventCount: 1,
      });
    if (
      buffer.owner === undefined ||
      buffer.owner.taskId !== state.taskId ||
      buffer.owner.generation !== state.generation
    )
      return yield* new ProviderEventIngestor.ProviderEventPublishError({
        providerSessionId: current.providerSessionId,
        eventCount: 1,
      });
    const nodeId = nodeIdOf(current.event);
    for (const held of buffer.events) {
      if (held.durable || !artifact(held.input.event) || nodeIdOf(held.input.event) !== nodeId)
        continue;
      yield* sql`INSERT INTO session_held_provider_events (run_id, task_id, task_generation, sequence, event_json)
        VALUES (${runId}, ${state.taskId}, ${state.generation},
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_held_provider_events WHERE run_id = ${runId}), ${encode({ ...held.input, runId })})
        ON CONFLICT (run_id, sequence) DO NOTHING`.pipe(
        Effect.mapError((cause) => publishError(current, cause)),
      );
      held.durable = true;
    }
  }, sql.withTransaction);
  const finish = Effect.fn("SessionReceiptHold.finish")(function* (runId: RunId, discard: boolean) {
    const buffer = buffers.get(runId);
    if (buffer === undefined) return;
    for (const held of buffer.events)
      if (!artifact(held.input.event)) yield* ingestor.ingestNormalized(held.input);
    const first = buffer.events[0];
    if (discard && first !== undefined)
      yield* removeRows(runId).pipe(Effect.mapError((cause) => publishError(first.input, cause)));
    buffers.delete(runId);
  });
  const flush = Effect.fn("SessionReceiptHold.flush")(function* (runId: RunId, buffer: Buffer) {
    const state = yield* gate.inspect(buffer.threadId, runId);
    if (state.state === "invalid" && state.discard) return yield* finish(runId, true);
    if (state.state !== "settled") return;
    if (
      state.status !== "running" ||
      state.activeAttemptId === null ||
      buffer.owner?.activeAttemptId !== state.activeAttemptId ||
      buffer.owner.taskId !== state.taskId ||
      buffer.owner.generation !== state.generation
    )
      return yield* finish(runId, state.status !== "completed" && state.status !== "running");
    const buffered = new Set(
      buffer.events.filter((held) => held.durable).map((held) => encode({ ...held.input, runId })),
    );
    const earlier = yield* sql<{
      readonly event_json: string;
    }>`SELECT event_json FROM session_held_provider_events
      WHERE run_id = ${runId} AND task_id = ${state.taskId} AND task_generation = ${state.generation} ORDER BY sequence`;
    for (const row of earlier)
      if (!buffered.has(row.event_json)) yield* ingestor.ingestNormalized(decode(row.event_json));
    for (const held of buffer.events) {
      yield* ingestor.ingestNormalized({
        ...held.input,
        writeIfRunCurrent: {
          runId,
          activeAttemptId: RunAttemptId.make(state.activeAttemptId),
          expectedStatus: "running",
        },
      });
    }
    yield* removeRows(runId);
    buffers.delete(runId);
  });
  const replay = Effect.fn("SessionReceiptHold.replay")(function* () {
    for (const [runId, buffer] of buffers) yield* sql.withTransaction(flush(runId, buffer));
    const rows = yield* sql<{
      readonly run_id: RunId;
      readonly task_id: string;
      readonly task_generation: number;
      readonly event_json: string;
    }>`
      SELECT * FROM session_held_provider_events ORDER BY run_id, sequence`;
    for (const row of rows) {
      if (buffers.has(row.run_id)) continue;
      const input = decode(row.event_json);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const state = yield* gate.inspect(input.threadId, row.run_id);
          if (state.state === "invalid" && state.discard) {
            yield* removeRows(row.run_id);
            return;
          }
          if (state.state !== "settled") return;
          if (
            state.taskId !== row.task_id ||
            state.generation !== row.task_generation ||
            ["cancelled", "interrupted", "failed", "rolled_back"].includes(state.status)
          ) {
            yield* removeRows(row.run_id);
            return;
          }
          yield* ingestor.ingestNormalized(input);
          yield* sql`DELETE FROM session_held_provider_events WHERE run_id = ${row.run_id} AND event_json = ${row.event_json}`;
        }),
      );
    }
  });
  const changes = yield* gate.subscribe;
  yield* replay();
  yield* changes.pipe(
    Effect.andThen(() =>
      replay().pipe(
        lock.withPermits(1),
        Effect.catchCause((cause) => Effect.logError("Session receipt replay failed", { cause })),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  return SessionReceiptHold.of({
    ingestNormalized: Effect.fn("SessionReceiptHold.ingestNormalized")(function* (input) {
      if (!isGoatBotSessionThreadId(input.threadId)) return yield* ingestor.ingestNormalized(input);
      const runId = input.runId;
      if (runId === undefined)
        return artifact(input.event) ? [] : yield* ingestor.ingestNormalized(input);
      if (!buffers.has(runId) && !artifact(input.event))
        return yield* ingestor.ingestNormalized(input);
      return yield* Effect.gen(function* () {
        const state = yield* gate.inspect(input.threadId, runId);
        if (
          (state.state === "held" || state.state === "settled") &&
          input.receiptAttemptId !== undefined &&
          input.receiptAttemptId !== state.activeAttemptId
        ) {
          yield* finish(runId, state.status !== "completed" && state.status !== "running");
          return [];
        }
        let buffer = buffers.get(runId);
        if (
          buffer === undefined &&
          (state.state === "absent" || state.state === "settled" || !artifact(input.event))
        )
          return yield* ingestor.ingestNormalized(input);
        if (buffer === undefined) {
          buffer = {
            threadId: input.threadId,
            events: [],
            owner: state.state === "held" || state.state === "settled" ? state : undefined,
          };
          buffers.set(runId, buffer);
        }
        if (buffer.owner === undefined && (state.state === "held" || state.state === "settled"))
          buffer.owner = state;
        if (
          input.event.type === "turn.terminal" ||
          (input.event.type === "provider_thread.updated" &&
            input.event.providerThread.status === "closed")
        ) {
          yield* finish(
            runId,
            input.event.type !== "turn.terminal" || input.event.status !== "completed",
          );
          const result = yield* ingestor.ingestNormalized(input);
          yield* gate.changed;
          return result;
        }
        buffer.events.push({ input, durable: false });
        if (
          messageArtifact(input.event) ||
          buffer.events.some(
            (held) => held.durable && nodeIdOf(held.input.event) === nodeIdOf(input.event),
          )
        )
          yield* stage(runId, buffer, input).pipe(
            Effect.mapError((cause) => publishError(input, cause)),
          );
        if (state.state === "settled")
          yield* sql
            .withTransaction(flush(runId, buffer))
            .pipe(Effect.mapError((cause) => publishError(input, cause)));
        return [];
      }).pipe(lock.withPermits(1));
    }),
    release: Effect.fn("SessionReceiptHold.release")((runId) =>
      finish(runId, true).pipe(lock.withPermits(1)),
    ),
  });
});

export const layer = Layer.effect(SessionReceiptHold, make);

export const wrap = Effect.fn("SessionReceiptHold.wrap")(function* () {
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  const hold = yield* Effect.serviceOption(SessionReceiptHold);
  const buffers = new Map<string, Input[]>();
  const release = Effect.fn("SessionReceiptHold.releaseWithoutGate")(function* (key: string) {
    for (const pending of buffers.get(key) ?? [])
      if (!artifact(pending.event)) yield* ingestor.ingestNormalized(pending);
    buffers.delete(key);
  });
  const withoutGate = Effect.fn("SessionReceiptHold.ingestWithoutGate")(function* (input: Input) {
    if (!isGoatBotSessionThreadId(input.threadId)) return yield* ingestor.ingestNormalized(input);
    const key = input.runId ?? input.threadId;
    if (
      input.event.type === "turn.terminal" ||
      (input.event.type === "provider_thread.updated" &&
        input.event.providerThread.status === "closed")
    ) {
      yield* release(key);
      return yield* ingestor.ingestNormalized(input);
    }
    if (artifact(input.event) || buffers.has(key)) {
      if (messageArtifact(input.event))
        return yield* new ProviderEventIngestor.ProviderEventPublishError({
          providerSessionId: input.providerSessionId,
          eventCount: 1,
        });
      const buffer = buffers.get(key) ?? [];
      buffer.push(input);
      buffers.set(key, buffer);
      return [];
    }
    return yield* ingestor.ingestNormalized(input);
  });
  return {
    ...ingestor,
    ingestNormalized: (input: Input) =>
      Option.isSome(hold) ? hold.value.ingestNormalized(input) : withoutGate(input),
    close: (runId: RunId, close: Effect.Effect<void>) =>
      close.pipe(
        Effect.ensuring(
          (Option.isSome(hold) ? hold.value.release(runId) : release(runId)).pipe(Effect.orDie),
        ),
      ),
  };
});
