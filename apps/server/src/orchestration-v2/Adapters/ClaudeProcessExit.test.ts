import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, ProviderSessionId, RunAttemptId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { assert, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import {
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
} from "./ClaudeTestInput.testkit.ts";
import { makeAssistantTextFrame, WAKE_NATIVE_SESSION } from "./ClaudeWakeFrames.testkit.ts";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

// regression: #26082 a killed Claude process names its signal on the failed turn
it.effect("names the signal that killed the Claude process on the failed turn", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-claude-v2-process-signal-",
    });
    const sdkMessages = yield* Queue.unbounded<
      SDKMessage,
      ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError
    >();
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
        open: () =>
          Effect.succeed({
            messages: Stream.fromQueue(sdkMessages),
            offer: () => Effect.void,
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            stopTask: () => Effect.void,
            interrupt: Effect.void,
            close: Queue.shutdown(sdkMessages),
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-process-signal");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-process-signal"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const terminal =
      yield* Deferred.make<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
      >();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        event.type === "turn.terminal" ? Deferred.succeed(terminal, event) : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* runtime.startTurn(
      makeClaudeTestTurnInput({
        threadId,
        providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-claude-process-signal"),
        text: "Write a long reply.",
        attachments: [],
      }),
    );
    yield* Queue.offer(
      sdkMessages,
      makeAssistantTextFrame({
        uuid: "00000000-0000-4000-8000-000000026082",
        text: "Here is the first part",
      }),
    );
    // Mirrors ProcessTransport.getProcessExitError in @anthropic-ai/claude-agent-sdk.
    const processExit = Object.assign(
      new Error(
        "Claude Code process terminated by signal SIGABRT. stderr: fork failed: Resource temporarily unavailable",
      ),
      {
        telemetryMessage: "Claude Code process terminated by signal SIGABRT",
        errorClass: "process_killed_by_signal",
        signal: "SIGABRT",
      },
    );
    yield* Queue.fail(
      sdkMessages,
      new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
        method: "messages",
        cause: processExit,
      }),
    );

    const settled = yield* Deferred.await(terminal);
    assert.equal(settled.status, "failed");
    if (settled.status !== "failed") return;
    assert.include(settled.failure.message, "Claude Code process terminated by signal SIGABRT");
    assert.notInclude(settled.failure.message, "stderr");
    assert.equal(settled.failure.code, "process_killed_by_signal");
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
