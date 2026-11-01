import { expect, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { fixture, layerAdapterTest } from "./CodexAdapterV2.attachment.testkit.ts";
import { codexThreadRuntimeParams } from "./CodexAdapterV2.ts";

it("disables session questions before an MCP credential is attached", () => {
  expect(
    codexThreadRuntimeParams({
      mcpSession: undefined,
      threadId: ThreadId.make("goat-bot-session:no-credential:1"),
    }).config["features.default_mode_request_user_input"],
  ).toBe(false);
});

it.each([true, false])(
  "session=%s disables native default-mode questions only for sessions",
  (session) => {
    const f = fixture("question-feature");
    const params = codexThreadRuntimeParams({
      mcpSession: {
        ...f.config,
        threadId: ThreadId.make(session ? "goat-bot-session:questions:1" : "ordinary"),
      },
    });
    expect(params.config["features.default_mode_request_user_input"]).toBe(
      session ? false : undefined,
    );
  },
);

it.effect.each([true, false])(
  "stale credential while busy: session=%s fails before turn/start; preserves ordinary behavior",
  (session) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("session-credential-" + session);
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.start();
        yield* f.turnStart(3, 1, false);
        yield* f.turnStart(4, 2, false);
        const replay = yield* f.open;
        yield* replay.startTurn(1);
        const threadId = session ? ThreadId.make("goat-bot-session:busy:1") : f.config.threadId;
        yield* sessions.set({
          ...f.config,
          threadId,
          providerSessionId: "credential-b",
          authorizationHeader: "Bearer fixture-b",
        });
        const result = yield* replay
          .startTurn(2, "turn-2", { threadId, providerThread: replay.providerThread })
          .pipe(Effect.exit);
        if (session) {
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain(
              "This GOAT Bot session's MCP credential could not be installed while the thread is busy; the turn did not start.",
            );
        } else expect(Exit.isSuccess(result)).toBe(true);
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
);
