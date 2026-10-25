import { assert, describe, it } from "@effect/vitest";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  childNodes,
  fixture,
  layerAdapterTest,
  spawnChild,
} from "./CodexAdapterV2.attachment.testkit.ts";
import { makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

describe("Codex Stop that fails after it ended the turn (#1654)", () => {
  const devServer = (status: "inProgress") => ({
    type: "commandExecution",
    id: "dev-server-command",
    command: "vp run dev",
    cwd: "/workspace",
    processId: "dev-server",
    source: "unifiedExecStartup",
    status,
    commandActions: [{ type: "unknown", command: "vp run dev" }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  });
  // Codex says it terminated nothing and still lists the terminal, so Stop fails.
  const terminalSurvives = (f: ReturnType<typeof fixture>, root: string, first: number) =>
    f.entries.push(
      {
        type: "expect_outbound",
        frame: {
          id: first,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: root, processId: "dev-server" },
        },
      },
      { type: "emit_inbound", frame: { id: first, result: { terminated: false } } },
      {
        type: "expect_outbound",
        frame: {
          id: first + 1,
          method: "thread/backgroundTerminals/list",
          params: { threadId: root },
        },
      },
      {
        type: "emit_inbound",
        frame: { id: first + 1, result: { data: [{ processId: "dev-server" }], nextCursor: null } },
      },
    );
  const stop = (
    replay: Effect.Success<ReturnType<typeof fixture>["open"]>,
    nativeTurnId: string,
    requestRuntimeRestart: boolean,
  ) =>
    Effect.gen(function* () {
      const allocator = yield* IdAllocator.IdAllocatorV2;
      return yield* replay.runtime
        .interruptTurn({
          providerThread: replay.providerThread,
          providerTurnId: allocator.derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId,
          }),
          requestRuntimeRestart,
        })
        .pipe(Effect.exit);
    });
  // A failed Stop keeps the error that failed it.
  const stopCause = (exit: Exit.Exit<void, ProviderAdapter.ProviderAdapterInterruptError>) => {
    assert.isTrue(Exit.isFailure(exit));
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    assert.instanceOf(error, ProviderAdapter.ProviderAdapterInterruptError);
    return error.cause;
  };
  const interrupt = (
    f: ReturnType<typeof fixture>,
    id: number,
    threadId: string,
    turnId: string,
    answer: Record<string, unknown> = { result: {} },
  ) =>
    f.entries.push(
      {
        type: "expect_outbound",
        frame: { id, method: "turn/interrupt", params: { threadId, turnId } },
      },
      { type: "emit_inbound", frame: { id, ...answer } },
    );
  const turn = (threadId: string, id: string, status: "inProgress" | "interrupted") => ({
    type: "emit_inbound" as const,
    frame: {
      method: status === "inProgress" ? "turn/started" : "turn/completed",
      params: { threadId, turn: makeCodexReplayTurn({ id, status }) },
    },
  });
  // A subagent a child's turn spawned: a grandchild of the root.
  const spawnUnder = (
    f: ReturnType<typeof fixture>,
    child: string,
    turnId: string,
    spawned: string,
  ) =>
    f.entries.push({
      type: "emit_inbound",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "subAgentActivity",
            id: `spawn-${spawned}`,
            kind: "started",
            agentThreadId: spawned,
            agentPath: "/root/child/grandchild",
          },
          threadId: child,
          turnId,
          completedAtMs: 1782622441500,
        },
      },
    });
  const lastNodes = (
    replay: Effect.Success<ReturnType<typeof fixture>["open"]>,
    allocator: IdAllocator.IdAllocatorV2["Service"],
    child: string,
  ) => childNodes(allocator, child).map((id) => replay.nodeStatuses.get(id)?.at(-1));

  it.effect("still ends a never-started subagent of the turn it confirmed stopped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "late-stop-error";
        const child = root + "-agent";
        const f = fixture(root);
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.start();
        yield* f.turnStart(3, 1, false);
        spawnChild(f, root, child);
        f.entries.push(
          {
            type: "emit_inbound",
            frame: {
              method: "item/started",
              params: {
                threadId: root,
                turnId: "turn-1",
                item: devServer("inProgress"),
                startedAtMs: 1782622441500,
              },
            },
          },
          {
            type: "expect_outbound",
            frame: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: root, turnId: "turn-1" },
            },
          },
          { type: "emit_inbound", frame: { id: 4, result: {} } },
        );
        terminalSurvives(f, root, 5);
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
        terminalSurvives(f, root, 7);
        // The next turn's events come after whatever the failed Stop emitted.
        yield* f.turnStart(9, 2, false);
        f.turnCompleted(2);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        const stopped = yield* stop(replay, "turn-1", true);
        assert.propertyVal(
          stopCause(stopped),
          "detail",
          "Codex background terminal dev-server remained active after termination.",
        );
        yield* replay.terminal;
        yield* replay.startTurn(2);
        yield* replay.terminal;
        const allocator = yield* IdAllocator.IdAllocatorV2;
        assert.deepStrictEqual(
          { task: replay.subagentStatuses.at(-1), nodes: lastNodes(replay, allocator, child) },
          { task: "interrupted", nodes: ["interrupted", "interrupted"] },
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  // Codex refused the interrupt and reported nothing ended. GOAT still finalizes the turn
  // itself, but that proves nothing about the child, which may start its work any moment.
  it.effect("leaves a never-started subagent running when Codex refused the Stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "stop-refused";
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
          { type: "emit_inbound", frame: { id: 4, error: { code: -32603, message: "busy" } } },
        );
        // The next turn's events come after whatever the failed Stop emitted.
        yield* f.turnStart(5, 2, false);
        f.turnCompleted(2);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        const stopped = yield* stop(replay, "turn-1", true);
        assert.propertyVal(stopCause(stopped), "errorMessage", "busy");
        yield* replay.terminal;
        yield* replay.startTurn(2);
        yield* replay.terminal;
        const allocator = yield* IdAllocator.IdAllocatorV2;
        assert.deepStrictEqual(
          { task: replay.subagentStatuses.at(-1), nodes: lastNodes(replay, allocator, child) },
          { task: "running", nodes: ["running", "running"] },
        );
        assert.isTrue(
          yield* replay.runtime.hasPendingBackgroundWorkForThread!(replay.providerThread),
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  // Codex confirmed the root ended, then refused to interrupt a child's turn. GOAT ends that turn
  // itself, which proves nothing about the grandchild it spawned.
  it.effect("ends the root's untouched subagents when a descendant refused the Stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "stop-refused-by-child";
        const [sibling, child, grandchild] = ["-sibling", "-child", "-grandchild"].map(
          (suffix) => root + suffix,
        );
        const f = fixture(root);
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.start();
        yield* f.turnStart(3, 1, false);
        spawnChild(f, root, sibling);
        spawnChild(f, root, child);
        f.entries.push(turn(child, "child-turn", "inProgress"));
        spawnUnder(f, child, "child-turn", grandchild);
        interrupt(f, 4, root, "turn-1");
        f.entries.push(turn(root, "turn-1", "interrupted"));
        interrupt(f, 5, child, "child-turn", { error: { code: -32603, message: "busy" } });
        yield* f.turnStart(6, 2, false);
        f.turnCompleted(2);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        const stopped = yield* stop(replay, "turn-1", true);
        assert.propertyVal(stopCause(stopped), "errorMessage", "busy");
        yield* replay.terminal;
        yield* replay.startTurn(2);
        yield* replay.terminal;
        const allocator = yield* IdAllocator.IdAllocatorV2;
        assert.deepStrictEqual(
          {
            sibling: lastNodes(replay, allocator, sibling),
            grandchild: lastNodes(replay, allocator, grandchild),
          },
          { sibling: ["interrupted", "interrupted"], grandchild: ["running", "running"] },
        );
        assert.isTrue(
          yield* replay.runtime.hasPendingBackgroundWorkForThread!(replay.providerThread),
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  // A child's turn started after Stop picked its turns. Codex acknowledged its interrupt but never
  // reported it ended, so Stop ended it itself before a surviving terminal failed the Stop.
  it.effect("keeps a subagent running under a turn Stop ended without Codex confirming", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "stop-unconfirmed-child";
        const child = root + "-child";
        const grandchild = root + "-grandchild";
        const f = fixture(root);
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.start();
        yield* f.turnStart(3, 1, false);
        f.entries.push({
          type: "emit_inbound",
          frame: {
            method: "item/started",
            params: {
              threadId: root,
              turnId: "turn-1",
              item: devServer("inProgress"),
              startedAtMs: 1782622441500,
            },
          },
        });
        spawnChild(f, root, child);
        interrupt(f, 4, root, "turn-1");
        f.entries.push(turn(child, "child-late", "inProgress"));
        spawnUnder(f, child, "child-late", grandchild);
        terminalSurvives(f, root, 5);
        f.entries.push(turn(root, "turn-1", "interrupted"));
        interrupt(f, 7, child, "child-late");
        terminalSurvives(f, root, 8);
        yield* f.turnStart(10, 2, false);
        f.turnCompleted(2);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        const stopped = yield* stop(replay, "turn-1", true);
        assert.propertyVal(
          stopCause(stopped),
          "detail",
          "Codex background terminal dev-server remained active after termination.",
        );
        yield* replay.terminal;
        yield* replay.startTurn(2);
        yield* replay.terminal;
        const allocator = yield* IdAllocator.IdAllocatorV2;
        assert.deepStrictEqual(lastNodes(replay, allocator, grandchild), ["running", "running"]);
        assert.isTrue(
          yield* replay.runtime.hasPendingBackgroundWorkForThread!(replay.providerThread),
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );
});
