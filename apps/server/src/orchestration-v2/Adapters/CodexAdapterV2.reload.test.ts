import { assert, describe, it } from "@effect/vitest";
import type * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { CODEX_TEST_MODEL_SELECTION, CODEX_TEST_RUNTIME_POLICY } from "./CodexAdapterV2.testkit.ts";
import {
  GOAT_MEMORY_TOOLS,
  codexReloadFixture,
  layerAdapterTest,
  spawnCodexChild,
  unusedRegistry,
} from "./CodexThreadReload.testkit.ts";

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
    const f = codexReloadFixture(scenario);
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* sessions.set({ ...f.config, nativeSubagentLimit: 3 });
    f.start(undefined, f.threadParams(undefined, f.config, GOAT_MEMORY_TOOLS, THREE_LANES));
    const dropLanes = sessions.set({ ...f.config, nativeSubagentLimit: 0 });
    // The reload that applies the dropped limit; returns the next request id.
    const reloadNoLanes = (first: number, threads?: ReadonlyArray<string>) =>
      f.reload(
        first,
        undefined,
        threads,
        undefined,
        f.threadParams(undefined, f.config, GOAT_MEMORY_TOOLS, NO_LANES),
      );
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
          spawnCodexChild(f, root, root + "-agent");
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
          const f = codexReloadFixture("authority-" + retry);
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
          const next = f.reload(5, undefined, undefined, undefined, params, failure);
          // Turn 4 reloads again, even when the credential is back to the one Codex last applied:
          // the dropped thread needs a resume either way.
          const retried = retry === "rotated" ? params : f.threadParams();
          yield* f.turnStart(f.reload(next, undefined, undefined, undefined, retried), 4, false);
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
          const f = codexReloadFixture("authority-held-resume");
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
          yield* f.turnStart(f.reload(5, undefined, undefined, undefined, params), 2, false);
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

  it.effect("defers a memory grant or revocation while the thread works, then reloads it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = codexReloadFixture("authority-memory");
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
          f.reload(5, undefined, undefined, undefined, f.threadParams(undefined, f.config, [])),
          3,
          false,
        );
        // Revoked while turn 3 runs: deferred, then reloaded once it ends.
        yield* f.turnStart(9, 4, false);
        f.turnCompleted(3);
        f.turnCompleted(4);
        yield* f.turnStart(f.reload(10), 5, false);
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
