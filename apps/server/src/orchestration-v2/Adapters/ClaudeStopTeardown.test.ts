import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";
import { CLAUDE_TEST_RUNTIME_POLICY, makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  Layer.effectContext(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "claude-adapter-test-" });
      return Context.make(HostProcess.HomeDirectory, home).pipe(
        Context.add(HostProcess.Environment, { HOME: home, PATH: "/usr/bin:/bin" }),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer)),
);

it.effect.each([
  { teardown: "before Stop" as const },
  { teardown: "during Stop's interrupt write" as const },
])("Stop with session teardown $teardown does not fail on the closed CLI", ({ teardown }) =>
  Effect.gen(function* () {
    const sessionScope = yield* Scope.make();
    let queryClosed = false;
    const harness = yield* makeWakeHarnessWithOptions({
      close: (sdkMessages) =>
        Effect.sync(() => {
          queryClosed = true;
        }).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
      interrupt: Effect.suspend(() =>
        teardown === "before Stop" ? Effect.void : Scope.close(sessionScope, Exit.void),
      ).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            queryClosed
              ? Effect.fail(
                  new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                    method: "interrupt",
                    cause: new Error("ProcessTransport is not ready for writing"),
                  }),
                )
              : Effect.void,
          ),
        ),
      ),
    }).pipe(Scope.provide(sessionScope));
    const now = yield* DateTime.now;
    const attemptId = RunAttemptId.make("attempt-claude-closed-scope-stop");
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    yield* harness.runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now,
        attemptId,
        text: "Hand this thread off to a worktree.",
        attachments: [],
      }),
    );
    // A workspace handoff detaches the session, closing its scope while the turn streams.
    if (teardown === "before Stop") {
      yield* Scope.close(sessionScope, Exit.void);
      assert.isTrue(queryClosed);
    }

    const interrupted = yield* Effect.exit(
      harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        }),
        requestRuntimeRestart: true,
      }),
    );

    assert.isTrue(Exit.isSuccess(interrupted), String(interrupted));
    assert.isTrue(queryClosed);
  }).pipe(Effect.provide(layerAdapterTest)),
);

it.effect("does not dispatch skill mentions from inline handoff history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-skill-handoff-" });
      const directory = path.join(homePath, "skills", "review");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "SKILL.md"),
        "---\nname: review\n---\nFollow the review instructions.\n",
      );
      const harness = yield* makeWakeHarnessWithOptions({
        settings: decodeClaudeSettings({ homePath }),
      });
      const history =
        "Context handoff:\n[Historical user; user_message]\n$review the diff\n\nUser message:\n";
      yield* harness.runtime.startTurn({
        ...makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("skill-handoff"),
          text: `${history}continue`,
          attachments: [],
          runtimePolicy: { ...CLAUDE_TEST_RUNTIME_POLICY, cwd: homePath },
        }),
        inlineContextLength: history.length,
      });
      const content = harness.offeredMessages[0]?.message.content;
      const blocks =
        typeof content === "string"
          ? [content]
          : (content ?? []).map((block) => (block.type === "text" ? block.text : ""));
      assert.isFalse(blocks.some((text) => text.startsWith("/review")));
      assert.include(blocks.join("\n"), "$review the diff");
    }).pipe(Effect.provide(layerAdapterTest)),
  ),
);
