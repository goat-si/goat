import { ClaudeSettings, ProviderSessionId, RunAttemptId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { assert, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { CLAUDE_TEST_MODEL_SELECTION, makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});

// Accepted as upstream b9381c257d has it: upstream preapproves the wait in read-only sandboxes,
// and it writes only the awaited flag on the caller's own tasks.
it.effect.each(["approval-required", "auto-accept-edits"] as const)(
  "a read-only sandbox outside Plan mode runs goat_background_wait without asking (%s)",
  (runtimeMode) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
        settings,
        environment: {},
        attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-wait-" }),
        fileSystem,
        path: yield* Path.Path,
        random: yield* SecureRandom.SecureRandom,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed("native-thread-claude-read-only-wait"),
          open: (input) =>
            Effect.sync(() => {
              openedOptions = input.options;
              return {
                messages: Stream.never,
                offer: () => Effect.void,
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                stopTask: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.void,
              };
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode,
        interactionMode: "default",
        cwd: "/workspace",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
      });
      const threadId = ThreadId.make("thread-claude-read-only-wait");
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-claude-read-only-wait"),
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId,
          providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-claude-read-only-wait"),
          text: "Run the tests in the background and wait.",
          attachments: [],
          runtimePolicy,
        }),
      );
      assert.notEqual(openedOptions?.permissionMode, "plan");
      const canUseTool = openedOptions?.canUseTool;
      if (canUseTool === undefined) throw new Error("A read-only sandbox installs the callback.");
      const asked = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      const decision = yield* Effect.promise(() =>
        canUseTool(
          "mcp__goat__goat_background_wait",
          { taskIds: ["task-1"] },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-wait",
            requestId: "request-wait",
            description: "Wait on the tests",
          },
        ),
      ).pipe(Effect.forkScoped);
      // Asking would post an approval request and wait for a person; the wait must not.
      const first = yield* Effect.raceFirst(
        Fiber.join(asked).pipe(Effect.as("asked" as const)),
        Fiber.join(decision).pipe(Effect.map((result) => result?.behavior)),
      );
      assert.equal(first, "allow");
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
