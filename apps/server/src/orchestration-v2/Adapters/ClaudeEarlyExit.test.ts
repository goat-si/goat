import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderSessionId, RunAttemptId, ThreadId } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
} from "./ClaudeTestInput.testkit.ts";
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
describe("Claude query exit before first frame", () => {
  const openAdapterWhoseFirstQueryEndsBeforeItsFirstFrame = Effect.fnUntraced(function* (
    name: string,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: `goat-claude-v2-${name}-`,
    });
    const deadStreamEnded = yield* Deferred.make<void>();
    let opened = 0;
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      // startTurn reads the auto-compact window from settings between opening the query and
      // attaching the turn; holding that read until the CLI's stream has ended pins the race.
      fileSystem: {
        ...fileSystem,
        readFileString: (filePath, encoding) =>
          opened === 1 && filePath.endsWith("settings.json")
            ? Deferred.await(deadStreamEnded).pipe(
                Effect.andThen(fileSystem.readFileString(filePath, encoding)),
              )
            : fileSystem.readFileString(filePath, encoding),
      },
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator,
      continuationRequests: { offer: () => Effect.void },
      queryRunner: {
        allocateSessionId: Effect.succeed(`native-${name}`),
        open: () =>
          Effect.gen(function* () {
            opened += 1;
            const sdkMessages = yield* Queue.unbounded<SDKMessage>();
            return {
              // The first CLI exits without writing a frame.
              messages:
                opened === 1
                  ? Stream.empty.pipe(Stream.ensuring(Deferred.succeed(deadStreamEnded, undefined)))
                  : Stream.fromQueue(sdkMessages),
              offer: () => Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              mcpServerStatus: Effect.succeed([]),
              readMcpResource: () => Effect.die("unexpected MCP resource read"),
              callMcpTool: () => Effect.die("unexpected MCP tool call"),
              listPermissionRules: Effect.die("unexpected permission rules read"),
              stopTask: () => Effect.void,
              interrupt: Effect.void,
              close: Queue.shutdown(sdkMessages),
            };
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make(`thread-${name}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${name}`),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const now = yield* DateTime.now;
    const turnInput = (attempt: string, providerTurnOrdinal: number) =>
      makeClaudeTestTurnInput({
        threadId,
        providerThread,
        now,
        attemptId: RunAttemptId.make(`attempt-${name}-${attempt}`),
        text: "Continue with the plan.",
        attachments: [],
        providerTurnOrdinal,
      });
    return { runtime, turnInput };
  });

  it.effect("fails a turn whose Claude query ends before its first frame", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* openAdapterWhoseFirstQueryEndsBeforeItsFirstFrame(
          "claude-query-dies-before-frame",
        );
        const started = yield* harness.runtime
          .startTurn(harness.turnInput("a", 1))
          .pipe(Effect.exit);
        assert.isTrue(
          Exit.isFailure(started),
          "a turn whose Claude query ended before its first frame started running on the dead query",
        );
        if (Exit.isFailure(started)) {
          assert.include(
            Cause.pretty(started.cause),
            "Claude provider query ended before the turn could start.",
          );
        }
        const followUp = yield* harness.runtime
          .startTurn(harness.turnInput("b", 2))
          .pipe(Effect.exit);
        assert.isTrue(
          Exit.isSuccess(followUp),
          `the turn whose query ended before its first frame is still active: ${
            Exit.isFailure(followUp) ? Cause.pretty(followUp.cause) : ""
          }`,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            MemoryDerivedCache.layer,
          ),
        ),
      ),
    ),
  );
});
