import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { layerTest, makeThread, threadCreatedEvent } from "./FoundationPersistence.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
it.layer(layerTest)("orchestration V2 shared projections", (it) => {
  it.effect("projects oversized tool bodies once before replay and live RPC retention", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* EventStore.EventStoreV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const thread = makeThread(ThreadId.make("thread:large-stream-body"), now);
        const output = {
          content: [{ type: "text", text: "first line\n" + "x".repeat(9 * 1024 * 1024) }],
        };
        const tool: OrchestrationV2TurnItem = {
          id: TurnItemId.make("tool:large-stream-body"),
          type: "dynamic_tool",
          threadId: thread.id,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: "Large tool",
          toolName: "mcp__large_tool",
          input: { query: "details" },
          output,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        const [created] = yield* sink.write({
          events: [
            threadCreatedEvent({ id: "event:large-stream-body:created", thread, now }),
            {
              id: EventId.make("event:large-stream-body:replay"),
              type: "turn-item.updated",
              threadId: thread.id,
              occurredAt: now,
              payload: tool,
            },
          ],
        });
        const subscribe = () =>
          Stream.toPull(
            sink.stream({
              threadId: thread.id,
              afterSequence: created!.sequence,
              bounded: true,
            }),
          );
        const pull = yield* subscribe();
        const other = yield* subscribe();
        const replay = yield* pull;
        assert.lengthOf(replay, 1);
        assert.lengthOf(yield* other, 1);
        assert.equal(replay[0]!.event.type, "turn-item.updated");
        assert.isBelow(Buffer.byteLength(yield* encodeJson(replay)), 4_000);
        const stringify = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(JSON, "stringify")),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const [completed] = yield* sink.write({
          events: [
            {
              id: EventId.make("event:large-stream-body:live"),
              type: "turn-item.updated",
              threadId: thread.id,
              occurredAt: now,
              payload: { ...tool, status: "completed", completedAt: now },
            },
          ],
        });
        const live = yield* pull;
        const otherLive = yield* other;
        assert.deepEqual(
          live.map((stored) => stored.sequence),
          [completed!.sequence],
        );
        // Both subscribers get one shared projection, so the live budget sizes it once.
        assert.strictEqual(otherLive[0], live[0]);
        assert.lengthOf(
          stringify.mock.calls.filter(([value]) => value === live[0] || value === otherLive[0]),
          1,
        );
        assert.isBelow(Buffer.byteLength(yield* encodeJson(live)), 4_000);
        for (const stored of [...replay, ...live]) {
          assert.equal(stored.event.type, "turn-item.updated");
          if (stored.event.type !== "turn-item.updated") return;
          assert.equal(stored.event.payload.type, "dynamic_tool");
          if (stored.event.payload.type !== "dynamic_tool") return;
          assert.notProperty(stored.event.payload, "output");
        }
        const persisted = yield* store.read({ threadId: thread.id }).pipe(Stream.runCollect);
        const fullEvent = persisted.find(
          (stored) => stored.sequence === completed!.sequence,
        )!.event;
        assert.equal(fullEvent.type, "turn-item.updated");
        if (fullEvent.type !== "turn-item.updated") return;
        assert.equal(fullEvent.payload.type, "dynamic_tool");
        if (fullEvent.payload.type !== "dynamic_tool") return;
        assert.deepEqual(fullEvent.payload.output, output);
        const detail = (yield* projections.getThreadProjection(thread.id)).turnItems.find(
          (item) => item.id === tool.id,
        )!;
        assert.equal(detail.type, "dynamic_tool");
        if (detail.type === "dynamic_tool") assert.deepEqual(detail.output, output);
      }),
    ),
  );
});
