import { assert, it, describe } from "@effect/vitest";
import { searchableMessageSegments } from "@goat/shared/threadFindText";
import { layerTestLoopback } from "@goat/shared/testing/loopbackHttpServer";
import {
  EventId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  OrchestrationV2SearchThreadError,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2TurnItem,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

import * as ProjectionStore from "./ProjectionStore.ts";
import { encodeThreadHistoryCursor } from "./threadHistoryPaging.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";

import {
  layerTest,
  at,
  createProject,
  thread,
  threadId,
  projectId,
  runId,
  item,
  run,
  commit,
  putItems,
} from "./ThreadFind.testkit.ts";

vi.mock("@goat/shared/threadFindText", { spy: true });

const setup = Effect.gen(function* () {
  yield* createProject(projectId);
  yield* commit([thread(threadId, projectId), run()]);
  return yield* ProjectionStore.ProjectionStoreV2;
});

const tracePayloadLoads = () => {
  let batches = 0;
  const tracer = Tracer.make({
    span(options) {
      if (options.name === "ThreadFind.load") batches++;
      return new Tracer.NativeSpan(options);
    },
  });
  return { tracer, batches: () => batches };
};

describe("V2 thread find", () => {
  it.live("matches only the authored indentation through the Find RPC", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([item("prompt", 1, "Plan\nneedle\n   needle", "user_message")]);
      const tag = ORCHESTRATION_V2_WS_METHODS.searchThread;
      const schema = OrchestrationV2RpcSchemas.searchThread;
      const group = RpcGroup.make(
        Rpc.make(tag, {
          payload: schema.input,
          success: schema.output,
          error: OrchestrationV2SearchThreadError,
        }),
      );
      const routes = RpcServer.layerHttp({ group, path: "/find", protocol: "http" }).pipe(
        Layer.provide(
          group.toLayer({
            [tag]: (input) =>
              projection
                .searchThread(input)
                .pipe(Effect.mapError((cause) => new OrchestrationV2SearchThreadError({ cause }))),
          }),
        ),
        Layer.provide(RpcSerialization.layerJson),
      );
      const services = yield* Layer.build(
        HttpRouter.serve(routes, { disableListenLog: true }).pipe(
          Layer.provideMerge(layerTestLoopback),
        ),
      );
      const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
      const client = yield* RpcClient.make(group).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url: `${origin}/find` }).pipe(
            Layer.provide(RpcSerialization.layerJson),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      );
      const search = (query: string) => client[tag]({ threadId, query });
      assert.equal((yield* search("   needle")).totalMatches, 1);
      assert.equal((yield* search("    needle")).totalMatches, 0);
      assert.equal((yield* search("needle")).totalMatches, 2);
      assert.equal((yield* Effect.exit(search("   ")))._tag, "Failure");
      assert.equal((yield* Effect.exit(search("x".repeat(201))))._tag, "Failure");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["rendered text", "source text"] as const)(
    "does not retain rendered snapshots over the %s budget",
    (limit) =>
      Effect.gen(function* () {
        const projection = yield* setup;
        yield* putItems(
          Array.from({ length: 65 }, (_, i) =>
            item(
              `message:${i}`,
              i,
              limit === "rendered text"
                ? "needle ".repeat(2500)
                : `needle ![image](data:image/png;base64,${"a".repeat(35000)})`,
            ),
          ),
        );
        const loads = tracePayloadLoads();
        const first = yield* projection
          .searchThread({ threadId, query: "needle" })
          .pipe(Effect.withTracer(loads.tracer));
        const initialBatches = loads.batches();
        const second = yield* projection
          .searchThread({ threadId, query: "need" })
          .pipe(Effect.withTracer(loads.tracer));
        assert.equal(second.totalMatches, first.totalMatches);
        assert.equal(loads.batches(), initialBatches * 2);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("finishes one snapshot while later searches include newly inserted matches", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([
        item("selected", 1, "snapshot needle"),
        item("last", 2, "snapshot last needle"),
      ]);
      yield* projection.searchThread({ threadId, query: "snapshot" });
      const frames = yield* projection.searchThreadStream({ threadId, query: "needle" }).pipe(
        Stream.tap((frame) =>
          frame.complete === false
            ? putItems([item("inserted", 0, "snapshot inserted needle")], "during-search")
            : Effect.void,
        ),
        Stream.runCollect,
      );
      assert.equal(frames.length, 2);
      assert.equal(frames[1]!.totalMatches, 2);
      assert.deepEqual(frames[1]!.match, frames[0]!.match);
      const updated = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "selected", occurrence: 0 },
      });
      assert.equal(updated.totalMatches, 3);
      assert.equal(updated.activeIndex, 1);
      assert.equal(updated.match?.entryId, "selected");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns bounded navigation counts around the selection, including wraparound", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems(
        Array.from({ length: 30 }, (_, i) =>
          item(`message:${i}`, i, "needle ".repeat((i % 3) + 1)),
        ),
      );
      const current = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "message:14", occurrence: 1 },
      });
      assert.equal(current.totalMatches, 60);
      assert.equal(current.activeIndex, 28);
      assert.equal(current.navigation?.length, 17);
      assert.deepEqual(
        current.navigation?.map((entry) => entry.entryId),
        Array.from({ length: 17 }, (_, i) => `message:${i + 6}`),
      );
      assert.deepEqual(
        current.navigation?.find((entry) => entry.entryId === "message:14"),
        {
          entryId: "message:14",
          runId,
          startIndex: 27,
          count: 3,
        },
      );
      const first = yield* projection.searchThread({ threadId, query: "needle" });
      assert.equal(first.navigation?.length, 17);
      assert.include(first.navigation?.map((entry) => entry.entryId) ?? [], "message:29");
      const empty = yield* projection.searchThread({ threadId, query: "absent" });
      assert.deepEqual(empty.navigation, []);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps navigation compact for a message with thousands of occurrences", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([item("many", 1, "needle ".repeat(5000))]);
      const result = yield* projection.searchThread({ threadId, query: "needle", index: 2000 });
      assert.equal(result.totalMatches, 5000);
      assert.equal(result.match?.occurrence, 2000);
      assert.deepEqual(result.navigation, [{ entryId: "many", runId, startIndex: 0, count: 5000 }]);
      assert.isBelow(JSON.stringify(result).length, 500);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("cycles relative to the current match when new matches are inserted", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([
        item("first", 10, "needle"),
        item("current", 20, "needle"),
        item("last", 30, "needle"),
      ]);
      const initial = yield* projection.searchThread({ threadId, query: "needle", index: 1 });
      assert.equal(initial.match?.entryId, "current");
      yield* putItems([
        item("new-before", 15, "needle"),
        item("new-after", 25, "needle"),
        item("new-last", 40, "needle"),
      ]);
      const start = { entryId: "current", occurrence: 0 };
      const refreshed = yield* projection.searchThread({ threadId, query: "needle", start });
      assert.equal(refreshed.totalMatches, 6);
      assert.equal(refreshed.activeIndex, 2);
      assert.equal(refreshed.match?.entryId, "current");
      const next = yield* projection.searchThread({ threadId, query: "needle", start, offset: 1 });
      assert.equal(next.match?.entryId, "new-after");
      const previous = yield* projection.searchThread({
        threadId,
        query: "needle",
        start,
        offset: -1,
      });
      assert.equal(previous.match?.entryId, "new-before");
      const end = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "last", occurrence: 0 },
        offset: 1,
      });
      assert.equal(end.match?.entryId, "new-last");
      const wrapped = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "new-last", occurrence: 0 },
        offset: 1,
      });
      assert.equal(wrapped.match?.entryId, "first");
      const backwards = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "first", occurrence: 0 },
        offset: -1,
      });
      assert.equal(backwards.match?.entryId, "new-last");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("searches visible rendered messages and plans in canonical item order", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([
        item("user", 1, "Check **the build**", "user_message"),
        item("assistant", 2, "check the build twice: check the build"),
        item("plan-item", 3, "# Check the build\nShip it", "proposed_plan"),
        item("url", 4, "[documentation](https://hidden.example/needle)"),
      ]);
      const matches = [];
      for (let index = 0; index < 4; index++) {
        const result = yield* projection.searchThread({
          threadId,
          query: "CHECK THE BUILD",
          index,
        });
        assert.equal(result.totalMatches, 4);
        matches.push(result.match);
      }
      assert.deepEqual(matches, [
        { entryId: "user", runId, occurrence: 0 },
        { entryId: "assistant", runId, occurrence: 0 },
        { entryId: "assistant", runId, occurrence: 1 },
        { entryId: "plan-item", runId, occurrence: 0 },
      ]);
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "hidden.example" })).totalMatches,
        0,
      );
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "check", index: 99 })).activeIndex,
        3,
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("skips the empty-response fallback the timeline hides beside an HTML render", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const shownRunId = RunId.make("run:shown");
      yield* commit([run(threadId, shownRunId, 2)]);
      yield* putItems([
        {
          ...item("render", 0, ""),
          type: "dynamic_tool",
          toolName: "html_render",
          input: {},
          output: { htmlRender: { attachmentId: "visual", title: "Result", height: 120 } },
        },
        item("hidden", 1, ""),
        { ...item("shown", 2, ""), runId: shownRunId },
      ]);
      const result = yield* projection.searchThread({ threadId, query: "empty" });
      assert.equal(result.totalMatches, 1);
      assert.equal(result.match?.entryId, "shown");
      const changed = yield* projection.searchThread({ threadId, query: "response" });
      assert.equal(changed.totalMatches, 1);
      assert.equal(changed.match?.entryId, "shown");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("searches displayed skill labels and invalidates parsed text when labels change", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([item("skill", 1, "Use $test-t3-app now")]);
      const input = {
        threadId,
        query: "T3 App Testing",
        skills: [{ name: "test-t3-app", displayName: "T3 App Testing" }],
      };
      assert.equal((yield* projection.searchThread(input)).totalMatches, 1);
      assert.equal((yield* projection.searchThread({ ...input, skills: [] })).totalMatches, 0);
      yield* putItems(
        [item("skill-plan", 2, "# Verify\nUse $test-t3-app now", "proposed_plan")],
        "plan",
      );
      assert.equal((yield* projection.searchThread(input)).totalMatches, 1);
      assert.equal(
        (yield* projection.searchThread({ ...input, query: "$test-t3-app" })).totalMatches,
        1,
      );
      assert.equal((yield* projection.searchThread({ ...input, query: "App" })).totalMatches, 2);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("refreshes file labels when the project cwd changes without a thread event", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* putItems([item("paths", 1, "[local](src/main.ts) [other](/elsewhere/src/main.ts)")]);
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "project:find/src" })).totalMatches,
        1,
      );
      yield* sql`UPDATE projection_projects SET workspace_root = '/elsewhere'
        WHERE project_id = ${projectId}`;
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "project:find" })).totalMatches,
        0,
      );
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "main.ts" })).totalMatches,
        2,
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("never mixes message versions when the searched thread changes during a scan", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const items = Array.from({ length: 260 }, (_, i) => item(`message:${i}`, i, "needle"));
      yield* putItems(items);
      const updated = items.map((item) =>
        item.type === "assistant_message" ? { ...item, text: "needle needle" } : item,
      );
      const [during] = yield* Effect.all(
        [
          projection.searchThread({ threadId, query: "needle" }),
          sql.withTransaction(putItems(updated, "concurrent")),
        ],
        { concurrency: "unbounded" },
      );
      assert.include([260, 520], during.totalMatches);
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "needle" })).totalMatches,
        520,
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("starts at the reading position and wraps when no later match exists", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([
        item("first", 1, "needle"),
        item("reading", 2, "needle above, needle below"),
        item("between", 3, "nothing"),
        item("last", 4, "needle"),
        item("end", 5, "nothing"),
      ]);
      const from = (entryId: string, occurrence = 0) =>
        projection.searchThread({ threadId, query: "needle", start: { entryId, occurrence } });
      assert.equal((yield* from("reading")).activeIndex, 1);
      const below = yield* from("reading", 1);
      assert.equal(below.activeIndex, 2);
      assert.equal(below.match?.occurrence, 1);
      assert.equal((yield* from("between")).match?.entryId, "last");
      assert.equal((yield* from("reading", 2)).activeIndex, 3);
      assert.equal((yield* from("end")).match?.entryId, "first");
      assert.equal((yield* from("missing")).activeIndex, 0);
      const explicit = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "last", occurrence: 0 },
        index: 1,
      });
      assert.equal(explicit.match?.entryId, "reading");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("finds matches beyond the recent history window", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const items = Array.from({ length: 520 }, (_, i) =>
        item(`message:${i}`, i + 1, i === 8 || i === 510 ? "sentinel" : "other message"),
      );
      yield* putItems(items);
      const loads = tracePayloadLoads();
      const first = yield* projection
        .searchThread({ threadId, query: "sentinel" })
        .pipe(Effect.withTracer(loads.tracer));
      assert.equal(loads.batches(), 5);
      const changed = yield* projection
        .searchThread({ threadId, query: "other message" })
        .pipe(Effect.withTracer(loads.tracer));
      assert.equal(changed.totalMatches, 518);
      assert.equal(changed.match?.entryId, "message:0");
      assert.equal(loads.batches(), 5);
      const last = yield* projection.searchThread({ threadId, query: "sentinel", index: 1 });
      assert.equal(first.totalMatches, 2);
      assert.equal(first.match?.entryId, "message:8");
      assert.equal(last.match?.entryId, "message:510");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps its caches while Find is in use and drops them after one idle minute", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([item("one", 1, "idle needle one"), item("two", 2, "idle needle two")]);
      const parses = () =>
        vi
          .mocked(searchableMessageSegments)
          .mock.calls.filter(([message]) => message.text.startsWith("idle needle")).length;
      const search = (query: string) => projection.searchThread({ threadId, query });
      // One idle minute passes inside this search. The later counts fail if it let the caches go.
      yield* projection.searchThreadStream({ threadId, query: "needle" }).pipe(
        Stream.tap((frame) =>
          frame.complete === false ? TestClock.adjust("1 minute") : Effect.void,
        ),
        Stream.runDrain,
      );
      assert.equal(parses(), 2);
      yield* TestClock.adjust("40 seconds");
      yield* search("idle");
      yield* TestClock.adjust("40 seconds");
      // A repeated query is answered from the completed scan and still counts as use.
      const repeated = yield* projection
        .searchThreadStream({ threadId, query: "needle" })
        .pipe(Stream.runCollect);
      assert.equal(repeated.length, 1);
      yield* TestClock.adjust("40 seconds");
      yield* search("one");
      assert.equal(parses(), 2);
      yield* TestClock.adjust("1 minute");
      yield* search("needle");
      assert.equal(parses(), 4);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("invalidates cached counts when streamed text changes or a run rolls back", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const original = item("streaming", 1, "needle");
      yield* putItems([original]);
      assert.equal((yield* projection.searchThread({ threadId, query: "needle" })).totalMatches, 1);
      if (original.type !== "assistant_message") return;
      yield* putItems([{ ...original, text: "needle needle", streaming: true }], "streaming");
      assert.equal((yield* projection.searchThread({ threadId, query: "needle" })).totalMatches, 2);
      assert.equal((yield* projection.searchThread({ threadId, query: "need" })).totalMatches, 2);
      const updated = run(threadId, runId, 1, "rolled_back");
      yield* commit([{ ...updated, type: "run.updated" }]);
      assert.equal((yield* projection.searchThread({ threadId, query: "needle" })).totalMatches, 0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "does not search undispatched inputs, cancelled queue rows, or folded question answers",
    () =>
      Effect.gen(function* () {
        const projection = yield* setup;
        const queuedRunId = RunId.make("queued:cancelled");
        yield* commit([run(threadId, queuedRunId, 2, "cancelled")]);
        const queued = item("cancelled", 1, "needle", "user_message");
        if (queued.type !== "user_message") return;
        const answer = item("async-answer:question", 2, "needle", "user_message");
        const question: OrchestrationV2TurnItem = {
          ...item("question", 3, ""),
          type: "user_input_request",
          requestId: RuntimeRequestId.make("question"),
          questions: [],
          questionAnswer: { requestId: "question", answers: {}, attachmentsByQuestionId: {} },
        };
        yield* putItems([
          { ...queued, runId: queuedRunId, inputIntent: "queued_turn" },
          answer,
          question,
        ]);
        const event: OrchestrationV2DomainEvent = {
          id: EventId.make("undispatched"),
          threadId,
          occurredAt: at(2),
          type: "message.updated",
          payload: {
            id: MessageId.make("undispatched"),
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: "needle",
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: at(2),
            updatedAt: at(2),
          },
        };
        yield* commit([event]);
        const result = yield* projection.searchThread({ threadId, query: "needle" });
        assert.equal(result.totalMatches, 0);
        assert.isNull(result.match);
        assert.equal((yield* projection.searchThread({ threadId, query: "need" })).totalMatches, 0);
        yield* putItems([{ ...question, questionAnswer: undefined }], "unfolded");
        assert.equal((yield* projection.searchThread({ threadId, query: "need" })).totalMatches, 1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("finds an async answer that started a later run", () =>
    Effect.gen(function* () {
      yield* createProject(projectId);
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const queuedRun = RunId.make("run:queued");
      const answerRun = RunId.make("run:answer");
      yield* commit([
        thread(threadId, projectId),
        run(),
        run(threadId, queuedRun, 2),
        run(threadId, answerRun, 3),
      ]);
      const requestId = RuntimeRequestId.make("late");
      const question: OrchestrationV2TurnItem = {
        ...item("question", 1, ""),
        type: "user_input_request",
        requestId,
        questions: [],
        questionAnswer: { requestId, answers: {}, attachmentsByQuestionId: {} },
      };
      const items = [
        question,
        { ...item("queued", 2, "queued follow-up", "user_message"), runId: queuedRun },
        { ...item(`async-answer:${requestId}`, 3, "needle", "user_message"), runId: answerRun },
      ];
      yield* commit(
        items.map((payload) => ({
          id: EventId.make(`${payload.id}:initial`),
          threadId,
          occurredAt: at(1),
          type: "turn-item.updated" as const,
          payload,
        })),
      );
      const result = yield* projection.searchThread({ threadId, query: "needle" });
      assert.equal(result.totalMatches, 1);
      assert.deepEqual(result.match, {
        entryId: `async-answer:${requestId}`,
        runId: answerRun,
        occurrence: 0,
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "searches inherited fork history through the fork boundary, using source item identities",
    () =>
      Effect.gen(function* () {
        const projection = yield* setup;
        const parent = ThreadId.make("thread:parent");
        const laterRun = RunId.make("run:later");
        const parentRun = RunId.make("run:parent");
        yield* commit([
          thread(parent, projectId),
          run(parent, parentRun),
          run(parent, laterRun, 2),
        ]);
        yield* putItems([
          { ...item("inherited", 1, "needle", "assistant_message", parent), runId: parentRun },
          { ...item("after-fork", 2, "needle", "assistant_message", parent), runId: laterRun },
        ]);
        const child = thread(threadId, projectId);
        if (child.type !== "thread.created") return;
        yield* commit([
          {
            ...child,
            id: EventId.make("child:fork"),
            type: "thread.metadata-updated",
            payload: {
              ...child.payload,
              forkedFrom: { type: "run", threadId: parent, runId: parentRun },
            },
          },
        ]);
        yield* putItems([item("local", 1, "needle")]);
        const inherited = yield* projection.searchThread({ threadId, query: "needle" });
        assert.equal(inherited.totalMatches, 2);
        assert.equal(inherited.match?.entryId, "inherited");
        assert.equal(
          (yield* projection.searchThread({ threadId, query: "needle", index: 1 })).match?.entryId,
          "local",
        );
        assert.equal((yield* projection.searchThread({ threadId, query: "need" })).totalMatches, 2);
        const snapshot = yield* projection.getThreadSnapshot(threadId);
        const history = yield* projection.getThreadHistoryPage(
          threadId,
          encodeThreadHistoryCursor({
            snapshotSequence: snapshot.snapshotSequence,
            sourceThreadId: threadId,
            sourceItemId: "local",
            position: 2,
          }),
        );
        assert.deepEqual(
          history.items,
          snapshot.projection.visibleTurnItems
            .slice(0, -1)
            .map((row) => ({ ...row, item: projectTurnItemForWire(row.item) })),
        );
        assert.equal(history.items[0]?.sourceThreadId, parent);
        assert.equal(history.items.at(-1)?.item.type, "fork");
        yield* putItems(
          [{ ...item("inherited", 1, "gone", "assistant_message", parent), runId: parentRun }],
          "parent-update",
        );
        assert.equal(
          (yield* projection.searchThread({ threadId, query: "needle" })).totalMatches,
          1,
        );
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects deleted threads and keeps results scoped to their thread", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const other = ThreadId.make("thread:other");
      yield* commit([thread(other, projectId), run(other, RunId.make("run:other"))]);
      yield* putItems([
        item("shared-id", 1, "needle"),
        item("other-id", 1, "other text", "assistant_message", other),
      ]);
      assert.equal((yield* projection.searchThread({ threadId, query: "needle" })).totalMatches, 1);
      assert.equal(
        (yield* projection.searchThread({ threadId: other, query: "needle" })).totalMatches,
        0,
      );
      const deleted = thread(threadId, projectId, { deletedAt: at(3) });
      if (deleted.type !== "thread.created") return;
      yield* commit([{ ...deleted, id: EventId.make("deleted"), type: "thread.deleted" }]);
      const error = yield* Effect.flip(projection.searchThread({ threadId, query: "needle" }));
      assert.equal(error._tag, "ProjectionStoreThreadNotFoundError");
      const historyError = yield* Effect.flip(
        projection.getThreadHistoryPage(
          threadId,
          encodeThreadHistoryCursor({
            snapshotSequence: 0,
            sourceThreadId: threadId,
            sourceItemId: "shared-id",
            position: 0,
          }),
        ),
      );
      assert.equal(historyError._tag, "ProjectionStoreThreadNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("invalidates a cached fork search when its empty source gains its first message", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const parent = ThreadId.make("thread:empty-parent");
      const parentRun = RunId.make("run:empty-parent");
      yield* commit([thread(parent, projectId), run(parent, parentRun)]);
      const child = thread(threadId, projectId);
      if (child.type !== "thread.created") return;
      yield* commit([
        {
          ...child,
          id: EventId.make("child:empty-fork"),
          type: "thread.metadata-updated",
          payload: {
            ...child.payload,
            forkedFrom: { type: "run", threadId: parent, runId: parentRun },
          },
        },
      ]);
      yield* putItems([item("local", 1, "needle")]);
      assert.equal((yield* projection.searchThread({ threadId, query: "needle" })).totalMatches, 1);
      yield* putItems([
        { ...item("inherited", 1, "needle", "assistant_message", parent), runId: parentRun },
      ]);
      const updated = yield* projection.searchThread({ threadId, query: "needle" });
      assert.equal(updated.totalMatches, 2);
      assert.equal(updated.match?.entryId, "inherited");
    }).pipe(Effect.provide(layerTest)),
  );
});
