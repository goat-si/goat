import { assert, describe, it } from "@effect/vitest";
import { ProviderThreadId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { CODEX_TEST_MODEL_SELECTION, CODEX_TEST_RUNTIME_POLICY } from "./CodexAdapterV2.testkit.ts";
import {
  childNodes,
  fixture,
  layerAdapterTest,
  spawnChild,
} from "./CodexAdapterV2.attachment.testkit.ts";
import { makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

// A parent turn giving a child work starts a send_input call naming it.
const sendInput = (root: string, child: string, turnId = "turn-2") => ({
  type: "emit_inbound" as const,
  frame: {
    method: "item/started",
    params: {
      threadId: root,
      turnId,
      item: {
        type: "collabAgentToolCall",
        id: "send-to-" + child,
        tool: "sendInput",
        status: "inProgress",
        senderThreadId: root,
        receiverThreadIds: [child],
        agentsStates: {},
      },
      startedAtMs: 1782622443000,
    },
  },
});

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
          // Its nodes end with its task, so neither the parent nor its own thread shows it running.
          assert.deepStrictEqual(
            childNodes(allocator, root + "-agent").map((id) => replay.nodeStatuses.get(id)?.at(-1)),
            ["interrupted", "interrupted"],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  // Codex also reports a turn that compaction replaced as interrupted; only Stop ends children.
  it.effect(
    "an interrupted turn without Stop leaves an initializing subagent counted (#1636)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "replaced-turn-child";
          const f = fixture(root);
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          spawnChild(f, root, root + "-agent");
          f.status(root, "idle");
          f.entries.push({
            type: "emit_inbound",
            frame: {
              method: "turn/completed",
              params: {
                threadId: root,
                turn: makeCodexReplayTurn({ id: "turn-1", status: "interrupted" }),
              },
            },
          });
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
    "a subagent Stop ended before it began runs again when a later turn starts it (#1636)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "stopped-child-reused";
          const child = root + "-agent";
          const f = fixture(root);
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          spawnChild(f, root, child);
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
          );
          // The next parent turn gives the child work: its first real turn runs and completes.
          yield* f.turnStart(5, 2, false);
          const childTurn = (status: "inProgress" | "completed") => ({
            type: "emit_inbound" as const,
            frame: {
              method: status === "inProgress" ? "turn/started" : "turn/completed",
              params: { threadId: child, turn: makeCodexReplayTurn({ id: "child-turn", status }) },
            },
          });
          f.entries.push(sendInput(root, child), childTurn("inProgress"), childTurn("completed"));
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
          assert.equal(replay.subagentStatuses.at(-1), "completed");
          assert.include(replay.subagentStatuses, "interrupted");
          // Both of its nodes run again for the new work, then end with it (#1654).
          assert.deepStrictEqual(
            childNodes(allocator, child).map((id) => replay.nodeStatuses.get(id)),
            [
              ["running", "interrupted", "running", "completed"],
              ["running", "interrupted", "running", "completed"],
            ],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "a stopped subagent whose first turn starts late, during the next parent turn, is still stopped (#1643)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "late-child-after-stop";
          const child = root + "-agent";
          const f = fixture(root);
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          spawnChild(f, root, child);
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
          );
          // The next parent turn runs, and the stopped child's spawned work starts only now. The
          // new turn gave it nothing, so the late turn is interrupted.
          yield* f.turnStart(5, 2, false);
          f.entries.push(
            {
              type: "emit_inbound",
              frame: {
                method: "turn/started",
                params: {
                  threadId: child,
                  turn: makeCodexReplayTurn({ id: "child-late", status: "inProgress" }),
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 6,
                method: "turn/interrupt",
                params: { threadId: child, turnId: "child-late" },
              },
            },
            { type: "emit_inbound", frame: { id: 6, result: {} } },
          );
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
          assert.equal(replay.subagentStatuses.at(-1), "interrupted");
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  // A child's own turn notifications, as Codex reports them on the child's thread.
  const childTurn = (child: string, id: string, status: "inProgress" | "completed") => ({
    type: "emit_inbound" as const,
    frame: {
      method: status === "inProgress" ? "turn/started" : "turn/completed",
      params: { threadId: child, turn: makeCodexReplayTurn({ id, status }) },
    },
  });

  it.effect("a failed parent turn's child that starts late keeps working (#1643)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "failed-parent-late-child";
        const child = root + "-agent";
        const f = fixture(root);
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.start();
        yield* f.turnStart(3, 1, false);
        spawnChild(f, root, child);
        f.status(root, "idle");
        f.entries.push({
          type: "emit_inbound",
          frame: {
            method: "turn/completed",
            params: {
              threadId: root,
              turn: makeCodexReplayTurn({ id: "turn-1", status: "failed" }),
            },
          },
        });
        // Native subagents keep working after a failed parent: no interrupt for the late turn.
        yield* f.turnStart(4, 2, false);
        f.entries.push(childTurn(child, "child-late", "inProgress"));
        f.entries.push(childTurn(child, "child-late", "completed"));
        f.turnCompleted(2);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        yield* replay.startTurn(2);
        yield* replay.terminal;
        assert.equal(replay.subagentStatuses.at(-1), "completed");
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "work a later turn sent a stopped child still runs when the child starts during a turn after that (#1643)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "stopped-child-assigned-earlier";
          const child = root + "-agent";
          const f = fixture(root);
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          spawnChild(f, root, child);
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
          );
          // Turn 2 sends the child new work and ends; the child only starts during turn 3.
          yield* f.turnStart(5, 2, false);
          f.entries.push(sendInput(root, child));
          f.turnCompleted(2);
          yield* f.turnStart(6, 3, false);
          f.entries.push(childTurn(child, "child-work", "inProgress"));
          f.entries.push(childTurn(child, "child-work", "completed"));
          f.turnCompleted(3);
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
          yield* replay.startTurn(3);
          yield* replay.terminal;
          assert.equal(replay.subagentStatuses.at(-1), "completed");
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("new work for a child leaves its stopped grandchild stopped (#1643)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "stopped-grandchild";
        const child = root + "-child";
        const grandchild = root + "-grandchild";
        const f = fixture(root);
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.start();
        yield* f.turnStart(3, 1, false);
        spawnChild(f, root, child);
        // The child runs a turn that spawns a grandchild, then finishes.
        f.entries.push(childTurn(child, "child-turn-1", "inProgress"), {
          type: "emit_inbound",
          frame: {
            method: "item/completed",
            params: {
              item: {
                type: "subAgentActivity",
                id: "spawn-" + grandchild,
                kind: "started",
                agentThreadId: grandchild,
                agentPath: "/root/child/grandchild",
              },
              threadId: child,
              turnId: "child-turn-1",
              completedAtMs: 1782622441500,
            },
          },
        });
        f.entries.push(childTurn(child, "child-turn-1", "completed"));
        // Stop ends the root turn before the grandchild ever started.
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
        );
        // Turn 2 sends the child new work; the grandchild's stopped work starts only now.
        yield* f.turnStart(5, 2, false);
        f.entries.push(
          sendInput(root, child),
          childTurn(grandchild, "grandchild-late", "inProgress"),
          {
            type: "expect_outbound",
            frame: {
              id: 6,
              method: "turn/interrupt",
              params: { threadId: grandchild, turnId: "grandchild-late" },
            },
          },
        );
        f.entries.push({ type: "emit_inbound", frame: { id: 6, result: {} } });
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
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("a grandchild sending input to its own parent child takes nothing over (#1643)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "grandchild-messages-parent";
        const child = root + "-child";
        const grandchild = root + "-grandchild";
        const f = fixture(root);
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.start();
        yield* f.turnStart(3, 1, false);
        spawnChild(f, root, child);
        f.entries.push(childTurn(child, "child-turn", "inProgress"), {
          type: "emit_inbound",
          frame: {
            method: "item/completed",
            params: {
              item: {
                type: "subAgentActivity",
                id: "spawn-" + grandchild,
                kind: "started",
                agentThreadId: grandchild,
                agentPath: "/root/child/grandchild",
              },
              threadId: child,
              turnId: "child-turn",
              completedAtMs: 1782622441500,
            },
          },
        });
        // The grandchild messages its parent: that must not make the child its own descendant.
        f.entries.push(childTurn(grandchild, "grandchild-turn", "inProgress"), {
          type: "emit_inbound",
          frame: {
            method: "item/started",
            params: {
              threadId: grandchild,
              turnId: "grandchild-turn",
              item: {
                type: "collabAgentToolCall",
                id: "reply-to-parent",
                tool: "sendInput",
                status: "inProgress",
                senderThreadId: grandchild,
                receiverThreadIds: [child],
                agentsStates: {},
              },
              startedAtMs: 1782622442000,
            },
          },
        });
        f.entries.push(childTurn(grandchild, "grandchild-turn", "completed"));
        f.entries.push(childTurn(child, "child-turn", "completed"));
        f.turnCompleted(1);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        assert.isFalse(
          yield* replay.runtime.hasPendingBackgroundWorkForThread!(replay.providerThread),
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "Stop after the parent turn finished still ends a subagent that never started a turn (#1645)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "stop-after-root-finished";
          const f = fixture(root);
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          spawnChild(f, root, root + "-agent");
          f.turnCompleted(1);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          assert.isTrue(yield* replay.runtime.hasPendingBackgroundWork!);
          // Nothing of the thread runs a turn, so Stop has no turn to interrupt.
          const allocator = yield* IdAllocator.IdAllocatorV2;
          yield* replay.runtime.interruptTurn({
            providerThread: replay.providerThread,
            providerTurnId: allocator.derive.providerTurn({
              driver: CodexAdapterV2.CODEX_DRIVER_KIND,
              nativeTurnId: "turn-1",
            }),
            requestRuntimeRestart: true,
          });
          assert.isFalse(yield* replay.runtime.hasPendingBackgroundWork!);
          assert.isFalse(
            yield* replay.runtime.hasPendingBackgroundWorkForThread!(replay.providerThread),
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "a child swept by a Stop after its root finished stays stopped when its turn starts late (#1643, #1645)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "late-child-after-finished-root";
          const child = root + "-agent";
          const f = fixture(root);
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          spawnChild(f, root, child);
          f.turnCompleted(1);
          // Stop comes after turn 1 finished; the child's spawned work starts during turn 2.
          yield* f.turnStart(4, 2, false);
          f.entries.push(childTurn(child, "child-late", "inProgress"), {
            type: "expect_outbound",
            frame: {
              id: 5,
              method: "turn/interrupt",
              params: { threadId: child, turnId: "child-late" },
            },
          });
          f.entries.push({ type: "emit_inbound", frame: { id: 5, result: {} } });
          f.turnCompleted(2);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          const allocator = yield* IdAllocator.IdAllocatorV2;
          yield* replay.runtime.interruptTurn({
            providerThread: replay.providerThread,
            providerTurnId: allocator.derive.providerTurn({
              driver: CodexAdapterV2.CODEX_DRIVER_KIND,
              nativeTurnId: "turn-1",
            }),
            requestRuntimeRestart: true,
          });
          yield* replay.startTurn(2);
          yield* replay.terminal;
          assert.isFalse(
            yield* replay.runtime.hasPendingBackgroundWorkForThread!(replay.providerThread),
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "Stop of another thread that swept a child leaves its sibling's next turn running (#1643)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "swept-sibling";
          const other = root + "-other-root";
          const child = root + "-child";
          const grandchild = root + "-grandchild";
          const sibling = root + "-sibling";
          const f = fixture(root);
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          const goalPaused = (thread: string, turnId: string) => ({
            type: "emit_inbound" as const,
            frame: {
              method: "thread/goal/updated",
              params: {
                threadId: thread,
                turnId,
                goal: {
                  threadId: thread,
                  objective: turnId,
                  status: "paused",
                  tokenBudget: null,
                  tokensUsed: 1,
                  timeUsedSeconds: 1,
                  createdAt: 1782622440,
                  updatedAt: 1782622450,
                },
              },
            },
          });
          f.start();
          yield* f.turnStart(3, 1, false);
          spawnChild(f, root, child);
          spawnChild(f, root, sibling);
          // The child spawns a grandchild that never starts a turn; the sibling keeps working.
          f.entries.push(childTurn(child, "child-1", "inProgress"), {
            type: "emit_inbound",
            frame: {
              method: "item/completed",
              params: {
                item: {
                  type: "subAgentActivity",
                  id: "spawn-" + grandchild,
                  kind: "started",
                  agentThreadId: grandchild,
                  agentPath: "/root/child/grandchild",
                },
                threadId: child,
                turnId: "child-1",
                completedAtMs: 1782622441500,
              },
            },
          });
          f.entries.push(
            childTurn(child, "child-1", "completed"),
            childTurn(sibling, "sibling-1", "inProgress"),
          );
          f.turnCompleted(1);
          f.entries.push(goalPaused(root, "turn-1"));
          // An independent root thread sends the child work, then a person stops that thread.
          const otherParams = f.threadParams();
          Object.assign(otherParams.config, {
            "shell_environment_policy.set.GOAT_ACP_MCP_ENDPOINT": f.config.endpoint,
            "shell_environment_policy.set.GOAT_ACP_MCP_AUTHORIZATION": f.config.authorizationHeader,
            "shell_environment_policy.set.T3_ACP_MCP_ENDPOINT": f.config.endpoint,
            "shell_environment_policy.set.T3_ACP_MCP_AUTHORIZATION": f.config.authorizationHeader,
          });
          f.resume(4, otherParams, undefined, other);
          yield* f.turnStart(5, 2, false, false, other);
          f.entries.push({
            type: "emit_inbound",
            frame: {
              method: "item/started",
              params: {
                threadId: other,
                turnId: "turn-2",
                item: {
                  type: "collabAgentToolCall",
                  id: "other-to-child",
                  tool: "sendInput",
                  status: "inProgress",
                  senderThreadId: other,
                  receiverThreadIds: [child],
                  agentsStates: {},
                },
                startedAtMs: 1782622443000,
              },
            },
          });
          f.turnCompleted(2, other);
          // The sibling, still the first root's work, starts its next turn after that Stop.
          yield* f.turnStart(6, 3, false, false, other);
          f.entries.push(
            childTurn(sibling, "sibling-1", "completed"),
            childTurn(sibling, "sibling-2", "inProgress"),
            childTurn(sibling, "sibling-2", "completed"),
            goalPaused(other, "turn-3"),
          );
          f.turnCompleted(3, other);
          // The replay answers outbound requests in order: a late interrupt of the sibling would
          // reach it before this turn's start and fail the run.
          yield* f.turnStart(7, 4, false, false, other);
          f.turnCompleted(4, other);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.goalTokens;
          const rootRef = replay.providerThread.nativeThreadRef;
          assert.isNotNull(rootRef);
          const otherThread = {
            ...replay.providerThread,
            id: ProviderThreadId.make("provider-thread-" + other),
            appThreadId: ThreadId.make("thread-" + other),
            nativeThreadRef: { ...rootRef, nativeId: other },
          };
          yield* sessions.set({ ...f.config, threadId: otherThread.appThreadId });
          yield* replay.runtime.resumeThread({
            threadId: otherThread.appThreadId,
            providerThread: otherThread,
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          });
          yield* replay.startTurn(2, "turn-2", {
            threadId: otherThread.appThreadId,
            providerThread: otherThread,
          });
          yield* replay.terminal;
          yield* replay.terminal;
          const allocator = yield* IdAllocator.IdAllocatorV2;
          yield* replay.runtime.interruptTurn({
            providerThread: otherThread,
            providerTurnId: allocator.derive.providerTurn({
              driver: CodexAdapterV2.CODEX_DRIVER_KIND,
              nativeTurnId: "turn-2",
            }),
            requestRuntimeRestart: true,
          });
          yield* replay.startTurn(3, "turn-3", {
            threadId: otherThread.appThreadId,
            providerThread: otherThread,
          });
          yield* replay.goalTokens;
          yield* replay.startTurn(4, "turn-4", {
            threadId: otherThread.appThreadId,
            providerThread: otherThread,
          });
          yield* replay.terminal;
          yield* replay.terminal;
          // The sweep interrupted only the grandchild; the sibling's turn ran to completion.
          assert.deepStrictEqual(
            replay.subagentStatuses.filter((status) => status === "interrupted"),
            ["interrupted"],
          );
          assert.isFalse(
            yield* replay.runtime.hasPendingBackgroundWorkForThread!(replay.providerThread),
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );
});
