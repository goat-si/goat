import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as EventSink from "../EventSink.ts";
import * as SessionReceiptHold from "./SessionReceiptHold.ts";
import * as Fixture from "./SessionReceipt.testkit.ts";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import { ProviderThreadId, ProviderTurnId } from "@goat/contracts";
import * as RuntimeLayer from "../runtimeLayer.ts";
import * as ServerConfig from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  captureRootRunTermination,
  driver,
  makeRunOwnedSubagentNodeFixture,
  rootTerminalEvent,
} from "../RunExecutionService.testkit.ts";

it.effect.each([true, false])(
  "session=%s: native approval is not published when the receipt service is missing",
  (session) =>
    Effect.gen(function* () {
      const published: string[] = [];
      const result = yield* captureRootRunTermination({
        key: "receipt-approval",
        session,
        shouldFinalizeRun: () => Effect.succeed(true),
        ingestNormalized: (input) =>
          Effect.sync(() => {
            published.push(input.event.type);
            return [];
          }),
        events: (ids) =>
          Stream.make(
            {
              type: "node.updated",
              driver,
              node: {
                ...makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
                kind: "approval_request",
              },
            },
            rootTerminalEvent(ids, "interrupted"),
          ),
      });
      expect(published.filter((type) => type === "node.updated")).toHaveLength(session ? 0 : 1);
      expect(result.observed).toContain("run:interrupted");
    }),
);

const layer = SessionReceiptHold.layer.pipe(Layer.provideMerge(Fixture.layer));
const cards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT runtime_request_id, status FROM orchestration_v2_projection_runtime_requests`;
});
const persistedQuestion = (count: number) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    return yield* sink
      .stream({ threadId: Fixture.threadId, eventType: "runtime-request.updated" })
      .pipe(Stream.take(count), Stream.runCollect);
  });

it.effect(
  "holds Claude forwarded ask, AskUserQuestion and Codex synchronous approval in order without blocking ingestion",
  () =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const hold = yield* SessionReceiptHold.SessionReceiptHold;
      for (const [key, driver, approval] of [
        ["forwarded-ask", "claudeAgent", true],
        ["ask-user", "claudeAgent", false],
        ["codex-approval", "codex", true],
      ] as const)
        for (const event of Fixture.question(key, "live", driver, approval))
          yield* hold.ingestNormalized(Fixture.input(event));
      expect(yield* cards).toHaveLength(0);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM orchestration_v2_projection_nodes`).toHaveLength(0);
      expect(yield* sql`SELECT * FROM orchestration_v2_projection_turn_items`).toHaveLength(0);
      const published = yield* persistedQuestion(3).pipe(Effect.forkChild);
      yield* Fixture.settle;
      const requests = yield* Fiber.join(published);
      expect(
        requests.map((event) =>
          event.event.type === "runtime-request.updated" ? event.event.payload.id : "unexpected",
        ),
      ).toEqual(["request:forwarded-ask", "request:ask-user", "request:codex-approval"]);
      expect(yield* cards).toHaveLength(3);
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["terminal", "close", "end"] as const)(
  "%s during a live-callback hold discards artifacts and later settlement cannot resurrect them",
  (ending) =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.gen(function* () {
        const hold = yield* SessionReceiptHold.SessionReceiptHold;
        for (const event of Fixture.question("stop", "live"))
          yield* hold.ingestNormalized(Fixture.input(event));
        if (ending === "terminal")
          yield* hold.ingestNormalized(
            Fixture.input({
              type: "turn.terminal",
              driver,
              providerThreadId: ProviderThreadId.make("provider-thread:stop"),
              providerTurnId: ProviderTurnId.make("provider-turn:stop"),
              runOrdinal: 1,
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            }),
          );
        else if (ending === "close")
          yield* hold.ingestNormalized(
            Fixture.input({
              type: "provider_thread.updated",
              driver,
              providerThread: {
                id: ProviderThreadId.make("provider-thread:stop"),
                driver,
                providerInstanceId: Fixture.providerInstanceId,
                providerSessionId: Fixture.providerSessionId,
                appThreadId: Fixture.threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "closed",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                contextUsage: null,
                nativeMetadata: null,
                goal: null,
                createdAt: DateTime.makeUnsafe(0),
                updatedAt: DateTime.makeUnsafe(0),
              },
            }),
          );
        else yield* hold.release(Fixture.runId);
        expect(yield* cards).toHaveLength(0);
      }).pipe(Effect.provide(SessionReceiptHold.layer));
      yield* Fixture.settle;
      yield* Effect.gen(function* () {
        yield* SessionReceiptHold.SessionReceiptHold;
        expect(yield* cards).toHaveLength(0);
        expect(yield* sql`SELECT * FROM session_held_provider_events`).toHaveLength(0);
      }).pipe(Effect.provide(SessionReceiptHold.layer));
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect.each(["live", "terminal-commit-crash", "publication-crash"] as const)(
  "Codex async question survives %s and settlement publishes one actionable question",
  (barrier) =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const sql = yield* SqlClient.SqlClient;
      const events = Fixture.question("async", "message");
      yield* Effect.gen(function* () {
        const hold = yield* SessionReceiptHold.SessionReceiptHold;
        for (const event of events) yield* hold.ingestNormalized(Fixture.input(event));
        expect(yield* cards).toHaveLength(0);
        expect(yield* sql`SELECT * FROM session_held_provider_events`).toHaveLength(3);
        yield* hold.ingestNormalized(
          Fixture.input({
            type: "turn.terminal",
            driver,
            providerThreadId: ProviderThreadId.make("provider-thread:async"),
            providerTurnId: ProviderTurnId.make("provider-turn:async"),
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          }),
        );
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed', payload_json = json_set(payload_json, '$.status', 'completed', '$.activeAttemptId', NULL, '$.completedAt', '1970-01-01T00:00:01.000Z') WHERE run_id = ${Fixture.runId}`;
        if (barrier === "live") {
          const published = yield* persistedQuestion(1).pipe(Effect.forkChild);
          yield* Fixture.settle;
          yield* Fiber.join(published);
          yield* hold.release(Fixture.runId);
        }
      }).pipe(Effect.provide(SessionReceiptHold.layer));
      yield* Fixture.settle;
      if (barrier === "publication-crash") {
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        for (const event of events) yield* ingestor.ingestNormalized(Fixture.input(event));
        expect(yield* cards).toHaveLength(1);
      }
      yield* Effect.gen(function* () {
        yield* SessionReceiptHold.SessionReceiptHold;
        const requests = yield* cards;
        expect(requests).toEqual([{ runtime_request_id: "request:async", status: "pending" }]);
        expect(
          yield* sql`SELECT json_extract(payload_json, '$.responseCapability.type') AS capability FROM orchestration_v2_projection_runtime_requests`,
        ).toEqual([{ capability: "message" }]);
        expect(yield* sql`SELECT * FROM session_held_provider_events`).toHaveLength(0);
        expect(
          yield* sql`SELECT * FROM orchestration_v2_projection_turn_items WHERE type = 'user_input_request'`,
        ).toHaveLength(1);
      }).pipe(Effect.provide(SessionReceiptHold.layer));
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect(
  "the production RuntimeLayer receipt composition holds native artifacts with a SQL-only gate",
  () =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const proxy = yield* SessionReceiptHold.wrap();
      const sql = yield* SqlClient.SqlClient;
      for (const event of Fixture.question("runtime-layer", "message"))
        yield* proxy.ingestNormalized(Fixture.input(event));
      expect(yield* cards).toHaveLength(0);
      expect(yield* sql`SELECT * FROM session_held_provider_events`).toHaveLength(3);
    }).pipe(
      Effect.provide(
        RuntimeLayer.layerSessionReceiptHold.pipe(
          Layer.provide(Fixture.layerNoProviderInstances),
          Layer.provideMerge(Fixture.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "receipt-runtime-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

it.effect.each(["generation", "cancelled", "missing-task"] as const)(
  "durable async questions respect %s ownership on restart",
  (change) =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.gen(function* () {
        const hold = yield* SessionReceiptHold.SessionReceiptHold;
        for (const event of Fixture.question("owned", "message"))
          yield* hold.ingestNormalized(Fixture.input(event));
      }).pipe(Effect.provide(SessionReceiptHold.layer));
      if (change === "generation") yield* sql`UPDATE channel_tasks SET generation = 2`;
      else if (change === "cancelled") yield* sql`UPDATE channel_tasks SET status = 'cancelled'`;
      else yield* sql`DELETE FROM channel_tasks`;
      yield* Fixture.settle;
      yield* Effect.gen(function* () {
        yield* SessionReceiptHold.SessionReceiptHold;
        expect(yield* cards).toHaveLength(0);
        expect(yield* sql`SELECT * FROM session_held_provider_events`).toHaveLength(
          change === "missing-task" ? 3 : 0,
        );
      }).pipe(Effect.provide(SessionReceiptHold.layer));
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect(
  "losing the active attempt discards live callback artifacts before a settlement flush",
  () =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const sql = yield* SqlClient.SqlClient;
      const hold = yield* SessionReceiptHold.SessionReceiptHold;
      const events = Fixture.question("old-attempt", "live");
      for (const event of events) yield* hold.ingestNormalized(Fixture.input(event));
      yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.activeAttemptId', 'new-attempt')`;
      yield* Fixture.settle;
      for (const event of events) yield* hold.ingestNormalized(Fixture.input(event));
      expect(yield* cards).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a resumed live buffer preserves older durable questions when settlement flushes it",
  () =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      yield* Effect.gen(function* () {
        const hold = yield* SessionReceiptHold.SessionReceiptHold;
        for (const event of Fixture.question("before-restart", "message"))
          yield* hold.ingestNormalized(Fixture.input(event));
      }).pipe(Effect.provide(SessionReceiptHold.layer));
      yield* Effect.gen(function* () {
        const hold = yield* SessionReceiptHold.SessionReceiptHold;
        const events = Fixture.question("after-restart", "message");
        for (const event of events) yield* hold.ingestNormalized(Fixture.input(event));
        yield* Fixture.settle;
        yield* hold.ingestNormalized(Fixture.input(events[2]!));
        expect(yield* cards).toHaveLength(2);
      }).pipe(Effect.provide(SessionReceiptHold.layer));
    }).pipe(Effect.provide(Fixture.layer)),
);
