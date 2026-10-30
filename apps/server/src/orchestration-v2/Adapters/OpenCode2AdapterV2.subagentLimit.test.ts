import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  RunAttemptId,
  RunId,
  type OrchestrationV2ProviderThread,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  CHILD,
  SESSION,
  backgroundLaunch,
  event,
  goatRules,
  instanceId,
  out,
  promptAccepted,
  reply,
  resumed,
  threadId,
  withLineage,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 native subagent limit", (it) => {
  const subagentDeny = { action: "subagent", resource: "*", effect: "deny" };
  const zeroLimitTurn = (
    runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    thread: OrchestrationV2ProviderThread,
  ) =>
    Effect.gen(function* () {
      const firstEnded = yield* Deferred.make<void>();
      const ended = yield* runtime.events.pipe(
        Stream.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        ),
        Stream.tap(() => Deferred.succeed(firstEnded, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(firstEnded);
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("environment-opencode2-subagents"),
        threadId,
        providerSessionId: "mcp-opencode2-subagents",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer opencode2-subagents",
        browserToolsAvailable: false,
        nativeSubagentLimit: 0,
      });
      yield* Effect.addFinalizer(() => sessions.clear(threadId));
      const second = yield* runtime
        .startTurn({
          ...withLineage(thread),
          runId: RunId.make("run:opencode2-adapter:2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("attempt:opencode2-adapter:2"),
        })
        .pipe(Effect.exit);
      return { second, ended };
    });

  it.effect(
    "denies OpenCode's subagent tool to the session and its running children at a zero limit",
    () =>
      Effect.gen(function* () {
        const { runtime, thread } = yield* resumed(
          [
            ...backgroundLaunch(CHILD),
            event("session.execution.succeeded", { sessionID: SESSION }),
            out("session.update", {
              sessionID: SESSION,
              permissions: [...goatRules, subagentDeny],
            }),
            reply("session.update", null),
            out("session.update", { sessionID: CHILD, permissions: [...goatRules, subagentDeny] }),
            reply("session.update", null),
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          { external: true },
        );
        const { second, ended } = yield* zeroLimitTurn(runtime, thread);
        assert.isTrue(Exit.isSuccess(second));
        assert.deepEqual(
          [...(yield* Fiber.join(ended))].map((terminal) => terminal.status),
          ["completed", "completed"],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("refuses the turn when a running child cannot take the zero limit's deny", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          ...backgroundLaunch(CHILD),
          event("session.execution.succeeded", { sessionID: SESSION }),
          out("session.update", { sessionID: SESSION, permissions: [...goatRules, subagentDeny] }),
          reply("session.update", null),
          out("session.update", { sessionID: CHILD, permissions: [...goatRules, subagentDeny] }),
          reply("session.update", { status: 502, body: { _tag: "UnknownError", message: "bad" } }),
        ],
        { external: true },
      );
      const { second } = yield* zeroLimitTurn(runtime, thread);
      assert.isTrue(Exit.isFailure(second));
    }).pipe(Effect.scoped),
  );
});
