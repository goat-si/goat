import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off -- creates a real versioned executable link.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, RunAttemptId, type ModelSelection } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  wakeTaskStarted,
  turnOneResult,
  makeResultFrame,
  claudeSdkFrame,
  WAKE_NATIVE_SESSION,
} from "./ClaudeWakeFrames.testkit.ts";
vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof Queue>();
  return {
    ...actual,
    take: <A, E>(queue: Queue.Dequeue<A, E>) =>
      Effect.gen(function* () {
        const capture = yield* CaptureEventQueue;
        if (capture !== undefined && actual.isEnqueue<unknown, never>(queue))
          yield* capture((marker) => actual.offer(queue, marker));
        return yield* actual.take(queue);
      }),
  };
});
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
describe("a model change after a Claude Code update", () => {
  /** An install as the Claude installer lays it out: one file per version and a link. */
  const makeInstall = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-program-" });
    const link = NodePath.join(root, "claude");
    const install = (version: string) => {
      const file = NodePath.join(root, version);
      NodeFS.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
      NodeFS.rmSync(link, { force: true });
      NodeFS.symlinkSync(file, link);
    };
    install("1.0.0");
    return {
      settings: { ...DEFAULT_CLAUDE_SETTINGS, binaryPath: link },
      update: () => install("1.0.1"),
    };
  });
  const opus = {
    instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
    model: "claude-opus-5-5",
  } satisfies ModelSelection;
  const sonnet = { ...opus, model: "claude-sonnet-4-6" } satisfies ModelSelection;

  it.effect("starts the new version, and only for the model change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const install = yield* makeInstall;
        const harness = yield* makeWakeHarnessWithOptions({
          settings: install.settings,
          close: (messages) => Queue.shutdown(messages),
          freshQueueOnReopen: true,
        });
        const now = yield* DateTime.now;
        const turn = (ordinal: number, modelSelection: ModelSelection) =>
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-updated-cli:${ordinal}`),
            text: `Request ${ordinal}`,
            attachments: [],
            providerTurnOrdinal: ordinal,
            modelSelection,
          });
        const settle = Effect.gen(function* () {
          yield* Queue.offer(harness.processQueues.at(-1) ?? harness.sdkMessages, turnOneResult);
          yield* Queue.take(harness.terminalReceipts);
        });
        yield* Effect.logInfo("debug-before-start");
        yield* harness.runtime.startTurn(turn(1, opus));
        yield* settle;

        // The update alone restarts nothing.
        install.update();
        yield* harness.runtime.startTurn(turn(2, opus));
        yield* settle;
        assert.lengthOf(harness.processQueues, 1);

        yield* harness.runtime.startTurn(turn(3, sonnet));
        assert.lengthOf(harness.processQueues, 2);
        assert.equal(harness.getOpenedOptions()?.model, "claude-sonnet-4-6");
        assert.deepEqual(harness.liveSelectionChanges, []);
        assert.lengthOf(harness.offeredMessages, 3);
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
  );

  it.effect("keeps a process that runs background work until that work ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const install = yield* makeInstall;
        const harness = yield* makeWakeHarnessWithOptions({
          settings: install.settings,
          close: (messages) => Queue.shutdown(messages),
          freshQueueOnReopen: true,
        });
        const now = yield* DateTime.now;
        const turn = (ordinal: number, modelSelection: ModelSelection) =>
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-updated-cli-background:${ordinal}`),
            text: `Request ${ordinal}`,
            attachments: [],
            providerTurnOrdinal: ordinal,
            modelSelection,
          });
        let resultOrdinal = 0;
        const settle = Effect.gen(function* () {
          yield* Queue.offer(
            harness.processQueues.at(-1) ?? harness.sdkMessages,
            makeResultFrame({
              uuid: `00000000-0000-4000-8000-00000000070${++resultOrdinal}`,
              result: "Done.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
        });
        yield* harness.runtime.startTurn(turn(1, opus));
        const originalOptions = harness.getOpenedOptions();
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* settle;
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        install.update();
        yield* harness.runtime.startTurn(turn(2, sonnet));
        yield* settle;
        assert.deepEqual(harness.liveSelectionChanges[0], { model: "claude-sonnet-4-6" });
        assert.strictEqual(harness.getOpenedOptions(), originalOptions);
        assert.lengthOf(harness.processQueues, 1);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "00000000-0000-4000-8000-000000000520",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        yield* harness.runtime.startTurn(turn(3, sonnet));
        assert.lengthOf(harness.processQueues, 2);
        assert.equal(harness.getOpenedOptions()?.model, "claude-sonnet-4-6");
        assert.lengthOf(harness.offeredMessages, 3);
      }).pipe(Effect.provide(layerClaudeAdapterTest)),
    ),
  );
});
