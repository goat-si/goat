import { assert, describe, it } from "@effect/vitest";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { ThreadId } from "@goat/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { fixture, layerAdapterTest } from "./CodexAdapterV2.attachment.testkit.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { CODEX_TEST_MODEL_SELECTION, CODEX_TEST_RUNTIME_POLICY } from "./CodexAdapterV2.testkit.ts";

// After a GOAT server restart a surviving Codex app-server still holds the thread with the credential
// the earlier server installed, and Codex ignores the overrides a resume of a held thread carries.
const noted = { computerUse: false, screenCode: false, reloadedAfterRestart: true };

const goatHeaders = (configs: ReadonlyArray<Record<string, unknown>>) =>
  configs.map(
    (config) =>
      (config["mcp_servers.goat"] as { http_headers: { Authorization: string } }).http_headers
        .Authorization,
  );

describe("Codex credential after a server restart", () => {
  it.effect(
    "a thread Codex already held is rejoined, then reloaded with the new credential at its next quiet turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("restart-held");
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          // Without overrides Codex only rejoins the held thread and cannot tear it down.
          f.resume(2, {});
          // A dead credential does not wait for background terminals: the reload never asks for
          // them, and the turn tells the agent they stopped.
          yield* f.turnStart(f.reload(3), 1, noted);
          f.turnCompleted(1);
          const replay = yield* f.openResumed("idle");
          yield* replay.startTurn(1);
          yield* replay.terminal;
          assert.include(replay.requests, "thread/unsubscribe");
          assert.deepEqual(goatHeaders(replay.threadConfigs), [f.config.authorizationHeader]);
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("the restart notice reaches the next turn when the reloading turn fails to start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("restart-notice");
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.resume(2, {});
        const failedStart = f.reload(3);
        yield* f.turnStart(failedStart, 1, noted);
        // Codex refuses that turn/start instead of starting the turn.
        f.entries.splice(-3, 3, {
          type: "emit_inbound",
          frame: { id: failedStart, error: { code: -32603, message: "turn/start failed" } },
        });
        yield* f.turnStart(failedStart + 1, 2, noted);
        f.turnCompleted(2);
        const replay = yield* f.openResumed("idle");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(replay.startTurn(1))));
        yield* replay.startTurn(2);
        yield* replay.terminal;
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("the restart notice survives a reload whose resume fails before a cold resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("restart-dropped");
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.resume(2, {});
        // The unsubscribe went through, so terminals may have stopped, but the resume failed.
        const next = f.reload(3, undefined, { error: { code: -32603, message: "resume failed" } });
        f.resume(next, f.threadParams());
        yield* f.turnStart(next + 1, 2, noted);
        f.turnCompleted(2);
        // Codex holds the thread at the first resume and has let it go by the second.
        const replay = yield* f.openResumed("idle", "notLoaded");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(replay.startTurn(1))));
        yield* replay.runtime.resumeThread({
          threadId: replay.threadId,
          providerThread: replay.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        yield* replay.startTurn(2);
        yield* replay.terminal;
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("a subagent still running from before the restart defers its parent's reload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("restart-child");
        const child = "restart-child-agent";
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.resume(2, {});
        // The child Codex lists still works, so the first turn starts without a reload.
        yield* f.turnStart(3, 1, false);
        f.turnCompleted(1);
        // Once Codex reports the child idle and no goal is active, the next turn reloads.
        yield* f.turnStart(
          f.reload(4, undefined, { threads: [f.nativeThreadId, child] }),
          2,
          noted,
        );
        f.turnCompleted(2);
        const replay = yield* f.openHeld({
          statuses: ["idle"],
          survivors: { [child]: { parent: f.nativeThreadId, statuses: ["active", "idle"] } },
        });
        for (const ordinal of [1, 2]) {
          yield* replay.startTurn(ordinal);
          yield* replay.terminal;
        }
        assert.deepEqual(goatHeaders(replay.threadConfigs), [f.config.authorizationHeader]);
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("a thread Codex loaded from the resume keeps the credential without a reload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("restart-cold");
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.resume(2, f.threadParams());
        yield* f.turnStart(3, 1, false);
        f.turnCompleted(1);
        const replay = yield* f.openResumed("notLoaded");
        yield* replay.startTurn(1);
        yield* replay.terminal;
        assert.notInclude(replay.requests, "thread/unsubscribe");
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );
});

describe("A held conversation after a server restart", () => {
  const child = (f: ReturnType<typeof fixture>) => f.nativeThreadId + "-agent";

  it.effect.each([
    { change: "starts work", statuses: ["idle", "active", "idle"], updates: [1] },
    { change: "works and goes idle", statuses: ["idle"], updates: [1, 2, 2] },
  ])(
    "a surviving subagent that $change during the check defers the reload",
    ({ change, statuses, updates }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("restart-race-" + change.replaceAll(" ", "-"));
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.resume(2, {});
          // Both threads look quiet and have no goal, but the child's second read shows it moved on.
          f.goalGet(3, f.nativeThreadId, { result: { goal: null } });
          f.goalGet(4, child(f), { result: { goal: null } });
          yield* f.turnStart(5, 1, false);
          f.turnCompleted(1);
          yield* f.turnStart(
            f.reload(6, undefined, { threads: [f.nativeThreadId, child(f)] }),
            2,
            noted,
          );
          f.turnCompleted(2);
          const replay = yield* f.openHeld({
            statuses: ["idle"],
            survivors: {
              [child(f)]: {
                parent: f.nativeThreadId,
                statuses: [...statuses],
                updates: [...updates],
              },
            },
          });
          for (const ordinal of [1, 2]) {
            yield* replay.startTurn(ordinal);
            yield* replay.terminal;
          }
          assert.deepEqual(goatHeaders(replay.threadConfigs), [f.config.authorizationHeader]);
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect.each([
    {
      failure: "the loaded-thread listing fails",
      listError: CodexErrors.CodexAppServerRequestError.internalError("listing failed"),
      malformed: false,
    },
    { failure: "a loaded thread cannot be read", listError: undefined, malformed: true },
  ])("a reload waits when $failure", ({ failure, listError, malformed }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("restart-unknown-" + (malformed ? "read" : "list"));
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.resume(2, {});
        // Codex could not tell what still runs, so the turn starts on the old credential.
        yield* f.turnStart(3, 1, false);
        f.turnCompleted(1);
        const replay = yield* f.openHeld({
          statuses: ["idle"],
          survivors: { [child(f)]: { parent: f.nativeThreadId, statuses: ["idle"], malformed } },
          ...(listError === undefined ? {} : { listError }),
        });
        yield* replay.startTurn(1);
        yield* replay.terminal;
        assert.notInclude(replay.requests, "thread/unsubscribe", failure);
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "a Codex that cannot list loaded threads holds no survivors, so the reload proceeds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("restart-no-listing");
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.resume(2, {});
          yield* f.turnStart(f.reload(3), 1, noted);
          f.turnCompleted(1);
          const replay = yield* f.openHeld({
            statuses: ["idle"],
            listError: CodexErrors.CodexAppServerRequestError.methodNotFound("thread/loaded/list"),
          });
          yield* replay.startTurn(1);
          yield* replay.terminal;
          assert.deepEqual(goatHeaders(replay.threadConfigs), [f.config.authorizationHeader]);
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("a held GOAT Bot session whose subagent still works refuses the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("restart-bot");
        const threadId = ThreadId.make("goat-bot-session:restart:1");
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set({ ...f.config, threadId });
        f.resume(2, {});
        const replay = yield* f.openHeld({
          statuses: ["idle"],
          threadId,
          survivors: { [child(f)]: { parent: f.nativeThreadId, statuses: ["active"] } },
        });
        const result = yield* Effect.exit(replay.startTurn(1));
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result))
          assert.include(
            Cause.pretty(result.cause),
            "This GOAT Bot session's MCP credential could not be installed while the thread is busy",
          );
        assert.notInclude(replay.requests, "turn/start");
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "a held thread whose GOAT credential was removed reloads with GOAT's server disabled",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("restart-detached");
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.resume(2, {});
          // The earlier server's goat entry stays in the held thread until a reload disables it.
          const params = {
            ...f.threadParams(),
            config: {
              ...CodexAdapterV2.CODEX_THREAD_CONFIG,
              mcp_servers: { goat: { enabled: false } },
            },
          };
          yield* f.turnStart(f.reload(3, undefined, { params }), 1, { ...noted, detached: true });
          f.turnCompleted(1);
          const replay = yield* f.openResumed("idle");
          yield* sessions.clear(f.config.threadId);
          yield* replay.startTurn(1);
          yield* replay.terminal;
          // The replay leaves host MCP servers out of its comparison, so check what Codex was sent.
          assert.deepEqual(replay.threadConfigs.at(-1)?.["mcp_servers"], {
            goat: { enabled: false },
          });
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );
});
