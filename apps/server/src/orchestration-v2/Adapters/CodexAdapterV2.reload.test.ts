import { assert, describe, it } from "@effect/vitest";
import { CheckpointId, NodeId, ProviderTurnId, RunAttemptId } from "@goat/contracts";
import type * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  withReplayRequestId,
} from "./CodexAdapterV2.testkit.ts";
import { makeCodexReplayTurn } from "./CodexReplay.testkit.ts";
import {
  GOAT_MEMORY_TOOLS,
  fixture,
  layerAdapterTest,
  spawnChild,
  unusedRegistry,
} from "./CodexAdapterV2.attachment.testkit.ts";

// The thread config Codex receives for each goatclaw subagent limit.
const THREE_LANES = {
  "agents.max_threads": 3,
  "features.multi_agent_v2.max_concurrent_threads_per_session": 4,
};
const NO_LANES = {
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "agents.enabled": false,
};
const lanesOf = (config: Record<string, unknown>) =>
  config["agents.max_threads"] ?? config["agents.enabled"];

/** A thread started with three subagent lanes whose profile then drops to none. */
const limitScenario = (scenario: string) =>
  Effect.gen(function* () {
    const f = fixture(scenario);
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* sessions.set({ ...f.config, nativeSubagentLimit: 3 });
    f.start(undefined, f.threadParams(undefined, f.config, GOAT_MEMORY_TOOLS, THREE_LANES));
    const dropLanes = sessions.set({ ...f.config, nativeSubagentLimit: 0 });
    // The reload that applies the dropped limit; returns the next request id.
    const reloadNoLanes = (first: number, threads?: ReadonlyArray<string>) =>
      f.reload(first, undefined, {
        ...(threads === undefined ? {} : { threads }),
        params: f.threadParams(undefined, f.config, GOAT_MEMORY_TOOLS, NO_LANES),
        terminals: true,
      });
    return { f, dropLanes, reloadNoLanes };
  });

describe("Codex subagent limit reload (#1572)", () => {
  it.effect(
    "keeps the old limit while the thread's own turn runs, then applies it at the next idle turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { f, dropLanes, reloadNoLanes } = yield* limitScenario("lanes-running-root");
          yield* f.turnStart(3, 1, false);
          // Input steered into the running turn goes straight to turn/start: no unsubscribe.
          yield* f.turnStart(4, 2, false);
          f.turnCompleted(1);
          f.turnCompleted(2);
          yield* f.turnStart(reloadNoLanes(5), 3, false);
          f.turnCompleted(3);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* dropLanes;
          yield* replay.startTurn(2);
          yield* replay.terminal;
          yield* replay.terminal;
          yield* replay.startTurn(3);
          yield* replay.terminal;
          assert.deepEqual(replay.threadConfigs.map(lanesOf), [3, false]);
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect.each(["running", "unreported"] as const)(
    "keeps the old limit while a subagent of a finished turn is %s, then applies it once Codex reports it idle",
    (child) =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = "lanes-child-" + child;
          const { f, dropLanes, reloadNoLanes } = yield* limitScenario(root);
          yield* f.turnStart(3, 1, false);
          spawnChild(f, root, root + "-agent");
          if (child === "running") f.status(root + "-agent", "active");
          f.turnCompleted(1);
          yield* f.turnStart(4, 2, false);
          f.status(root + "-agent", "idle");
          f.turnCompleted(2);
          yield* f.turnStart(reloadNoLanes(5, [root, root + "-agent"]), 3, false);
          f.turnCompleted(3);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          yield* dropLanes;
          for (const ordinal of [2, 3]) {
            yield* replay.startTurn(ordinal);
            yield* replay.terminal;
          }
          assert.deepEqual(replay.threadConfigs.map(lanesOf), [3, false]);
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("keeps the old limit while a started turn has not been reported yet", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { f, dropLanes, reloadNoLanes } = yield* limitScenario("lanes-pending-start");
        yield* f.turnStart(3, 1, false);
        // Codex admits turn 2 before publishing turn 1's idle; turn 2's own notifications come later.
        yield* f.turnStart(4, 2, false);
        const turnTwoStarted = f.entries.splice(-2);
        f.turnCompleted(1);
        yield* f.turnStart(5, 3, false);
        f.entries.push(...turnTwoStarted);
        f.turnCompleted(2);
        f.turnCompleted(3);
        yield* f.turnStart(reloadNoLanes(6), 4, false);
        f.turnCompleted(4);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.startTurn(2);
        yield* replay.terminal;
        yield* dropLanes;
        yield* replay.startTurn(3);
        yield* replay.terminal;
        yield* replay.terminal;
        yield* replay.startTurn(4);
        yield* replay.terminal;
        assert.deepEqual(replay.threadConfigs.map(lanesOf), [3, false]);
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("keeps the old limit while a goal is active, then applies it once none is", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "lanes-goal-active";
        const { f, dropLanes, reloadNoLanes } = yield* limitScenario(root);
        yield* f.turnStart(3, 1, false);
        f.turnCompleted(1);
        f.goalGet(4, root, {
          result: {
            goal: {
              threadId: root,
              objective: "Keep working",
              status: "active",
              tokenBudget: null,
              tokensUsed: 10,
              timeUsedSeconds: 3,
              createdAt: 1782622440,
              updatedAt: 1782622450,
            },
          },
        });
        yield* f.turnStart(5, 2, false);
        f.turnCompleted(2);
        yield* f.turnStart(reloadNoLanes(6), 3, false);
        f.turnCompleted(3);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        yield* dropLanes;
        for (const ordinal of [2, 3]) {
          yield* replay.startTurn(ordinal);
          yield* replay.terminal;
        }
        assert.deepEqual(replay.threadConfigs.map(lanesOf), [3, false]);
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );
});

describe("Codex GOAT authority reload (#1569)", () => {
  // Codex 0.163.0 keeps a held thread's MCP headers and disabled tools across thread/resume.
  const goatServer = (config: Record<string, unknown>) =>
    config["mcp_servers.goat"] as { http_headers: { Authorization: string }; disabled_tools: [] };

  it.effect.each(["rotated", "reverted"] as const)(
    "reaches a held thread with a rotated credential only through a quiet reload, and retries a failed one (%s)",
    (retry) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("authority-" + retry);
          const rotated = {
            ...f.config,
            providerSessionId: "credential-rotated",
            authorizationHeader: "Bearer rotated",
          };
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          // Rotated while turn 1 runs: nothing reaches Codex until the thread is quiet.
          yield* f.turnStart(4, 2, false);
          f.turnCompleted(1);
          f.turnCompleted(2);
          // Turn 3: the resume fails after Codex dropped the thread, so the turn fails with it.
          const failure = { code: -32603, message: "rollout unavailable" };
          const params = f.threadParams(undefined, rotated);
          const next = f.reload(5, undefined, { params, error: failure, terminals: true });
          // Turn 4 reloads again, even when the credential is back to the one Codex last applied:
          // the dropped thread needs a resume either way.
          const retried = retry === "rotated" ? params : f.threadParams();
          yield* f.turnStart(
            f.reload(next, undefined, { params: retried, terminals: true }),
            4,
            false,
          );
          f.turnCompleted(4);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* sessions.set(rotated);
          yield* replay.startTurn(2);
          yield* replay.terminal;
          yield* replay.terminal;
          assert.isTrue(Exit.isFailure(yield* replay.startTurn(3).pipe(Effect.exit)));
          if (retry === "reverted") yield* sessions.set(f.config);
          yield* replay.startTurn(4);
          yield* replay.terminal;
          assert.deepEqual(
            replay.threadConfigs.map((config) => goatServer(config).http_headers.Authorization),
            [
              "Bearer fixture-cua",
              "Bearer rotated",
              retry === "rotated" ? "Bearer rotated" : "Bearer fixture-cua",
            ],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "leaves a credential that changed before a held thread's resume to the next quiet reload",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("authority-held-resume");
          const rotated = {
            ...f.config,
            providerSessionId: "credential-rotated",
            authorizationHeader: "Bearer rotated",
          };
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          f.turnCompleted(1);
          // The session manager resumes a thread it still holds when the run's model or policy
          // changes. Codex ignores the new credential there, so the next turn still reloads.
          const params = f.threadParams(undefined, rotated);
          f.resume(4, params);
          yield* f.turnStart(f.reload(5, undefined, { params, terminals: true }), 2, false);
          f.turnCompleted(2);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          yield* sessions.set(rotated);
          yield* replay.runtime.resumeThread({
            threadId: f.config.threadId,
            providerThread: replay.providerThread,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
            modelSelection: CODEX_TEST_MODEL_SELECTION,
          });
          yield* replay.startTurn(2);
          yield* replay.terminal;
          assert.deepEqual(
            replay.threadConfigs.map((config) => goatServer(config).http_headers.Authorization),
            ["Bearer fixture-cua", "Bearer rotated", "Bearer rotated"],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "keeps a thread held when unloading it fails, so a later resume still leaves a change to a quiet reload",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("authority-unload-failed");
          const rotated = {
            ...f.config,
            providerSessionId: "credential-rotated",
            authorizationHeader: "Bearer rotated",
          };
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          yield* f.turnStart(3, 1, false);
          f.turnCompleted(1);
          f.entries.push(
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "thread/unsubscribe",
                params: { threadId: f.nativeThreadId },
              },
            },
            { type: "emit_inbound", frame: { id: 4, error: { code: -32603, message: "busy" } } },
          );
          const params = f.threadParams(undefined, rotated);
          f.resume(5, params);
          yield* f.turnStart(f.reload(6, undefined, { params, terminals: true }), 2, false);
          f.turnCompleted(2);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* replay.terminal;
          const unload = replay.runtime.unloadThread!({ providerThread: replay.providerThread });
          assert.isTrue(Exit.isFailure(yield* unload.pipe(Effect.exit)));
          yield* sessions.set(rotated);
          yield* replay.runtime.resumeThread({
            threadId: f.config.threadId,
            providerThread: replay.providerThread,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
            modelSelection: CODEX_TEST_MODEL_SELECTION,
          });
          yield* replay.startTurn(2);
          yield* replay.terminal;
          assert.deepEqual(
            replay.threadConfigs.map((config) => goatServer(config).http_headers.Authorization),
            ["Bearer fixture-cua", "Bearer rotated", "Bearer rotated"],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("records what a rollback load applies to a thread a failed reload dropped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("authority-rollback-load");
        const credential = (name: string) => ({
          ...f.config,
          providerSessionId: `credential-${name}`,
          authorizationHeader: `Bearer ${name}`,
        });
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.start();
        const threadResult = f.entries.at(-1)!;
        yield* f.turnStart(3, 1, false);
        f.turnCompleted(1);
        // Turn 2's reload drops the thread and fails to load it again.
        const failure = { code: -32603, message: "rollout unavailable" };
        f.reload(4, undefined, {
          params: f.threadParams(undefined, credential("b")),
          error: failure,
          terminals: true,
        });
        // Rollback finds the thread unloaded and loads it with credential b before reverting.
        f.entries.push(
          {
            type: "expect_outbound",
            frame: {
              id: 8,
              method: "thread/read",
              params: { threadId: f.nativeThreadId, includeTurns: false },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              id: 8,
              result: {
                thread: {
                  id: f.nativeThreadId,
                  historyMode: "paginated",
                  status: { type: "notLoaded" },
                },
              },
            },
          },
        );
        f.resume(9, f.threadParams(undefined, credential("b")));
        f.entries.push(
          {
            type: "expect_outbound",
            frame: {
              id: 10,
              method: "thread/turns/list",
              params: {
                threadId: f.nativeThreadId,
                cursor: null,
                limit: 1,
                sortDirection: "desc",
                itemsView: "summary",
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              id: 10,
              result: {
                data: [makeCodexReplayTurn({ id: "turn-1", status: "completed" })],
                nextCursor: null,
              },
            },
          },
          {
            type: "expect_outbound",
            frame: {
              id: 11,
              method: "thread/revert",
              params: { threadId: f.nativeThreadId, beforeTurnId: "turn-1" },
            },
          },
          withReplayRequestId(threadResult, 11),
        );
        // Now held with b: a resume with c changes nothing, and the next turn reloads c.
        const params = f.threadParams(undefined, credential("c"));
        f.resume(12, params);
        yield* f.turnStart(f.reload(13, undefined, { params, terminals: true }), 3, false);
        f.turnCompleted(3);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        yield* replay.terminal;
        yield* sessions.set(credential("b"));
        assert.isTrue(Exit.isFailure(yield* replay.startTurn(2).pipe(Effect.exit)));
        const now = yield* DateTime.now;
        yield* replay.runtime.rollbackThread({
          providerThread: replay.providerThread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint-rollback"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [
            {
              id: ProviderTurnId.make("provider-turn-rollback"),
              providerThreadId: replay.providerThread.id,
              nodeId: NodeId.make("node-rollback"),
              runAttemptId: RunAttemptId.make("attempt-rollback"),
              nativeTurnRef: {
                driver: replay.providerThread.driver,
                nativeId: "turn-1",
                strength: "strong",
              },
              ordinal: 1,
              status: "completed",
              startedAt: now,
              completedAt: now,
            },
          ],
        });
        yield* sessions.set(credential("c"));
        yield* replay.runtime.resumeThread({
          threadId: f.config.threadId,
          providerThread: replay.providerThread,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
        });
        yield* replay.startTurn(3);
        yield* replay.terminal;
        assert.deepEqual(
          replay.threadConfigs.map((config) => goatServer(config).http_headers.Authorization),
          ["Bearer fixture-cua", "Bearer b", "Bearer b", "Bearer c", "Bearer c"],
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("defers a memory grant or revocation while the thread works, then reloads it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("authority-memory");
        const granted: McpProviderSession.McpProviderSessionConfig = {
          ...f.config,
          grantedScopes: ["memory:read", "memory:write", "orchestration:read"],
        };
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.start();
        yield* f.turnStart(3, 1, false);
        // Granted while turn 1 runs: deferred.
        yield* f.turnStart(4, 2, false);
        f.turnCompleted(1);
        f.turnCompleted(2);
        yield* f.turnStart(
          f.reload(5, undefined, {
            params: f.threadParams(undefined, f.config, []),
            terminals: true,
          }),
          3,
          false,
        );
        // Revoked while turn 3 runs: deferred, then reloaded once it ends.
        yield* f.turnStart(10, 4, false);
        f.turnCompleted(3);
        f.turnCompleted(4);
        yield* f.turnStart(f.reload(11, undefined, { terminals: true }), 5, false);
        f.turnCompleted(5);
        // The registry backs the grant; the adapter offers memory tools only under a live policy.
        const replay = yield* f.openWith({
          ...unusedRegistry,
          currentMemoryPolicy: () => Effect.succeed({ grant: "read_write", policyEpoch: 1 }),
        });
        yield* replay.startTurn(1);
        yield* sessions.set(granted);
        yield* replay.startTurn(2);
        yield* replay.terminal;
        yield* replay.terminal;
        yield* replay.startTurn(3);
        yield* sessions.set(f.config);
        yield* replay.startTurn(4);
        yield* replay.terminal;
        yield* replay.terminal;
        yield* replay.startTurn(5);
        yield* replay.terminal;
        assert.deepEqual(
          replay.threadConfigs.map((config) => goatServer(config).disabled_tools.length),
          [GOAT_MEMORY_TOOLS.length, 0, GOAT_MEMORY_TOOLS.length],
        );
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );
});
