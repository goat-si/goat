import { assert, describe, it } from "@effect/vitest";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { fixture, layerAdapterTest, spawnChild } from "./CodexAdapterV2.attachment.testkit.ts";
import { makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

describe("Codex Stop of a turn Codex queued behind a running turn", () => {
  // Codex queued the second start behind turn-1: it answered without a start time and never started it.
  const queuedBehindRunningTurn = (scenario: string) =>
    Effect.gen(function* () {
      const f = fixture(scenario);
      yield* (yield* McpProviderSessions.McpProviderSessions).set(f.config);
      f.start();
      yield* f.turnStart(3, 1, false);
      yield* f.turnStart(4, 2, false);
      f.entries.splice(-3, 3, {
        type: "emit_inbound",
        frame: {
          id: 4,
          result: {
            turn: {
              ...makeCodexReplayTurn({ id: "turn-2", status: "inProgress" }),
              startedAt: null,
            },
          },
        },
      });
      return f;
    });
  const interrupted = (f: ReturnType<typeof fixture>, id: number, turnId: string) =>
    f.entries.push(
      {
        type: "expect_outbound",
        frame: {
          id,
          method: "turn/interrupt",
          params: { threadId: f.nativeThreadId, turnId },
        },
      },
      { type: "emit_inbound", frame: { id, result: {} } },
      {
        type: "emit_inbound",
        frame: {
          method: "turn/completed",
          params: {
            threadId: f.nativeThreadId,
            turn: makeCodexReplayTurn({ id: turnId, status: "interrupted" }),
          },
        },
      },
    );
  const stopTurn2 = (replay: Effect.Success<ReturnType<typeof fixture>["open"]>) =>
    Effect.gen(function* () {
      const allocator = yield* IdAllocator.IdAllocatorV2;
      return yield* replay.runtime
        .interruptTurn({
          providerThread: replay.providerThread,
          providerTurnId: allocator.derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "turn-2",
          }),
        })
        .pipe(Effect.exit, Effect.forkScoped);
    });
  const statusOf = (
    terminals: ReadonlyArray<{ readonly providerTurnId: string; readonly status: string }>,
  ) =>
    Effect.gen(function* () {
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const id = (nativeTurnId: string) =>
        allocator.derive.providerTurn({ driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeTurnId });
      return ["turn-1", "turn-2"].map(
        (turn) => terminals.find((terminal) => terminal.providerTurnId === id(turn))?.status,
      );
    });

  it.effect(
    "regression: a queued turn that never starts no longer blocks Stop of the running turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* queuedBehindRunningTurn("stop-queued-never-starts");
          interrupted(f, 5, "turn-1");
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.startTurn(2);
          const stop = yield* stopTurn2(replay);
          yield* TestClock.adjust("10 seconds");
          assert.deepStrictEqual(yield* Fiber.join(stop), Exit.void);
          const terminals = [yield* replay.terminal, yield* replay.terminal];
          assert.deepStrictEqual(yield* statusOf(terminals), ["interrupted", "interrupted"]);
          assert.deepStrictEqual(
            replay.requests.filter((method) => method === "turn/interrupt"),
            ["turn/interrupt"],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("interrupts the queued turn too when Codex starts it after the running turn ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* queuedBehindRunningTurn("stop-queued-starts-late");
        interrupted(f, 5, "turn-1");
        f.entries.push({
          type: "emit_inbound",
          frame: {
            method: "turn/started",
            params: {
              threadId: f.nativeThreadId,
              turn: makeCodexReplayTurn({ id: "turn-2", status: "inProgress" }),
            },
          },
        });
        interrupted(f, 6, "turn-2");
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.startTurn(2);
        const stop = yield* stopTurn2(replay);
        assert.deepStrictEqual(yield* Fiber.join(stop), Exit.void);
        const terminals = [yield* replay.terminal, yield* replay.terminal];
        assert.deepStrictEqual(yield* statusOf(terminals), ["interrupted", "interrupted"]);
        assert.lengthOf(
          replay.requests.filter((method) => method === "turn/interrupt"),
          2,
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "interrupts a queued turn that Codex starts after Stop settled it, retrying a refusal",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* queuedBehindRunningTurn("stop-queued-starts-after-timeout");
          interrupted(f, 5, "turn-1");
          f.entries.push({
            type: "emit_inbound",
            afterMs: 15_000,
            frame: {
              method: "turn/started",
              params: {
                threadId: f.nativeThreadId,
                turn: makeCodexReplayTurn({ id: "turn-2", status: "inProgress" }),
              },
            },
          });
          f.entries.push(
            {
              type: "expect_outbound",
              frame: {
                id: 6,
                method: "turn/interrupt",
                params: { threadId: f.nativeThreadId, turnId: "turn-2" },
              },
            },
            { type: "emit_inbound", frame: { id: 6, error: { code: -32603, message: "busy" } } },
          );
          interrupted(f, 7, "turn-2");
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.startTurn(2);
          const stop = yield* stopTurn2(replay);
          yield* TestClock.adjust("10 seconds");
          assert.deepStrictEqual(yield* Fiber.join(stop), Exit.void);
          const terminals = [yield* replay.terminal, yield* replay.terminal];
          assert.deepStrictEqual(yield* statusOf(terminals), ["interrupted", "interrupted"]);
          assert.equal(yield* replay.interrupted, "turn-1");
          yield* TestClock.adjust("30 seconds");
          assert.deepStrictEqual(
            [yield* replay.interrupted, yield* replay.interrupted],
            ["turn-2", "turn-2"],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("still interrupts the queued turn when interrupting the running turn fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* queuedBehindRunningTurn("stop-queued-blocker-refused");
        f.entries.push(
          {
            type: "expect_outbound",
            frame: {
              id: 5,
              method: "turn/interrupt",
              params: { threadId: f.nativeThreadId, turnId: "turn-1" },
            },
          },
          // turn-1 ended on its own just before the interrupt reached Codex.
          {
            type: "emit_inbound",
            frame: { id: 5, error: { code: -32600, message: "no active turn to interrupt" } },
          },
          {
            type: "emit_inbound",
            frame: {
              method: "turn/completed",
              params: {
                threadId: f.nativeThreadId,
                turn: makeCodexReplayTurn({ id: "turn-1", status: "completed" }),
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              method: "turn/started",
              params: {
                threadId: f.nativeThreadId,
                turn: makeCodexReplayTurn({ id: "turn-2", status: "inProgress" }),
              },
            },
          },
        );
        interrupted(f, 6, "turn-2");
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.startTurn(2);
        const stop = yield* stopTurn2(replay);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(stop)));
        assert.deepStrictEqual(
          [yield* replay.interrupted, yield* replay.interrupted],
          ["turn-1", "turn-2"],
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("interrupts a subagent's turn while Codex has not answered the root's interrupt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "stop-unanswered-root";
        const child = root + "-child";
        const f = fixture(root);
        yield* (yield* McpProviderSessions.McpProviderSessions).set(f.config);
        f.start();
        yield* f.turnStart(3, 1, false);
        spawnChild(f, root, child);
        const turnEvent = (threadId: string, id: string, status: "inProgress" | "interrupted") => ({
          type: "emit_inbound" as const,
          frame: {
            method: status === "inProgress" ? "turn/started" : "turn/completed",
            params: { threadId, turn: makeCodexReplayTurn({ id, status }) },
          },
        });
        const expectInterrupt = (id: number, threadId: string, turnId: string) => ({
          type: "expect_outbound" as const,
          frame: { id, method: "turn/interrupt", params: { threadId, turnId } },
        });
        f.entries.push(
          turnEvent(child, "child-turn", "inProgress"),
          // A paused goal's update tells the test the child's turn has registered.
          {
            type: "emit_inbound",
            frame: {
              method: "thread/goal/updated",
              params: {
                threadId: root,
                turnId: "turn-1",
                goal: {
                  threadId: root,
                  objective: "fence",
                  status: "paused",
                  tokenBudget: null,
                  tokensUsed: 1,
                  timeUsedSeconds: 1,
                  createdAt: 1782622440,
                  updatedAt: 1782622450,
                },
              },
            },
          },
          // Codex answers the root's interrupt only after the child's.
          expectInterrupt(4, root, "turn-1"),
          expectInterrupt(5, child, "child-turn"),
          { type: "emit_inbound", frame: { id: 5, result: {} } },
          turnEvent(child, "child-turn", "interrupted"),
          { type: "emit_inbound", frame: { id: 4, result: {} } },
          turnEvent(root, "turn-1", "interrupted"),
        );
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.goalTokens;
        const allocator = yield* IdAllocator.IdAllocatorV2;
        const stop = yield* replay.runtime
          .interruptTurn({
            providerThread: replay.providerThread,
            providerTurnId: allocator.derive.providerTurn({
              driver: CodexAdapterV2.CODEX_DRIVER_KIND,
              nativeTurnId: "turn-1",
            }),
          })
          .pipe(Effect.exit, Effect.forkScoped);
        assert.deepStrictEqual(
          [yield* replay.interrupted, yield* replay.interrupted],
          ["turn-1", "child-turn"],
        );
        assert.deepStrictEqual(yield* Fiber.join(stop), Exit.void);
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );
});
