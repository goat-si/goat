import { assert, describe, it } from "@effect/vitest";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { fixture, layerAdapterTest } from "./CodexAdapterV2.attachment.testkit.ts";

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
