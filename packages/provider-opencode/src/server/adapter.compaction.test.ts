import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { asyncEventStream, makeOpenCodeRuntimeHarness } from "./adapter.harness.testkit.ts";

describe("OpenCodeAdapterV2 compaction", () => {
  // OpenCode 1.18.18 reports a context overflow as session.error, then auto-compacts and continues.
  it.effect("keeps a turn running through a context overflow that OpenCode auto-compacts", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      let promptId = "";
      const harness = yield* makeOpenCodeRuntimeHarness("context-overflow", "root", {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          promptAsync: async (input: { messageID: string }) => {
            promptId = input.messageID;
            return { data: true };
          },
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const status = (type: "busy" | "idle") => ({
        type: "session.status",
        properties: { sessionID: "root", status: { type } },
      });
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "root",
            info: { id: promptId, role: "user", time: { created: 1 } },
          },
        }),
      );
      yield* Effect.promise(() => nativeEvents.push(status("busy")));
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.error",
          properties: {
            sessionID: "root",
            error: {
              name: "ContextOverflowError",
              data: {
                message:
                  "This model's maximum context length is 131070 tokens. However, your messages resulted in 140049 tokens.",
              },
            },
          },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({ type: "session.compacted", properties: { sessionID: "root" } }),
      );
      yield* Effect.promise(() => nativeEvents.push(status("busy")));
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.part.updated",
          properties: {
            sessionID: "root",
            part: {
              id: "post-compaction-text",
              sessionID: "root",
              messageID: "post-compaction-assistant",
              type: "text",
              text: "Post-compaction step",
              time: { start: 2 },
            },
          },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "root",
            info: {
              id: "post-compaction-assistant",
              sessionID: "root",
              role: "assistant",
              time: { created: 2, completed: 3 },
              parentID: promptId,
            },
          },
        }),
      );
      yield* Effect.promise(() => nativeEvents.push(status("idle")));

      const events = Array.from(yield* Fiber.join(received));
      const terminal = events.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.status, "completed");
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text === "Post-compaction step",
        ),
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("fails an explicit compaction that OpenCode reports as a context overflow", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const harness = yield* makeOpenCodeRuntimeHarness("compact-overflow", "root", {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          summarize: async () => {
            await nativeEvents.push({
              type: "session.error",
              properties: {
                sessionID: "root",
                error: {
                  name: "ContextOverflowError",
                  data: { message: "This model's maximum context length is 131070 tokens." },
                },
              },
            });
            return { data: true };
          },
        },
      });
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* harness.startTurn("/compact");

      const events = Array.from(yield* Fiber.join(received));
      const terminal = events.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.status, "failed");
      assert.equal(
        terminal?.failure?.message,
        "This model's maximum context length is 131070 tokens.",
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        ),
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
});
