import { assert, describe, it } from "@effect/vitest";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { fixture, layerAdapterTest, spawnChild } from "./CodexAdapterV2.attachment.testkit.ts";
import { makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

describe("Codex native subagents as their thread's background work", () => {
  // Settling a run and releasing an idle session ask the adapter per thread (#1571).
  it.effect(
    "counts a running subagent as its thread's background work after the parent turn ends (#1571)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "background-child";
          const f = fixture(root);
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          spawnChild(f, root, root + "-agent");
          f.status(root + "-agent", "active");
          f.turnCompleted(1);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          assert.isTrue(
            yield* replay.runtime.hasPendingBackgroundWorkForThread!(replay.providerThread),
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "Stop ends a subagent that registered before its first turn started, so it stops counting as work (#1636)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "stop-early-child";
          const f = fixture(root);
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          spawnChild(f, root, root + "-agent");
          f.entries.push(
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "turn/interrupt",
                params: { threadId: root, turnId: "turn-1" },
              },
            },
            { type: "emit_inbound", frame: { id: 4, result: {} } },
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: root,
                  turn: makeCodexReplayTurn({ id: "turn-1", status: "interrupted" }),
                },
              },
            },
            // Codex reports the child's interruption on the stopped turn, which is dropped.
            {
              type: "emit_inbound",
              frame: {
                method: "item/completed",
                params: {
                  threadId: root,
                  turnId: "turn-1",
                  item: {
                    type: "subAgentActivity",
                    id: "late-interrupted-child",
                    kind: "interrupted",
                    agentThreadId: root + "-agent",
                    agentPath: "/root/child",
                  },
                  completedAtMs: 1782622442000,
                },
              },
            },
          );
          yield* f.turnStart(5, 2, false);
          f.turnCompleted(2);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          const allocator = yield* IdAllocator.IdAllocatorV2;
          yield* replay.runtime.interruptTurn({
            providerThread: replay.providerThread,
            providerTurnId: allocator.derive.providerTurn({
              driver: CodexAdapterV2.CODEX_DRIVER_KIND,
              nativeTurnId: "turn-1",
            }),
            requestRuntimeRestart: true,
          });
          yield* replay.terminal;
          yield* replay.startTurn(2);
          yield* replay.terminal;
          assert.isFalse(
            yield* replay.runtime.hasPendingBackgroundWorkForThread!(replay.providerThread),
          );
          assert.isFalse(yield* replay.runtime.hasPendingBackgroundWork!);
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );
});
