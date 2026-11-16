import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings, ProviderSessionId, RunAttemptId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as ProviderInstallationGate from "../../provider/ProviderInstallationGate.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { CLAUDE_TEST_MODEL_SELECTION, makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { unusedRegistry } from "./CodexAdapterV2.attachment.testkit.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});

it.effect("opens each turn's Claude process inside the installation gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const log: Array<string> = [];
      const instanceId = ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID;
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId,
        settings,
        environment: {},
        attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-gate-" }),
        fileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        installationGate: ProviderInstallationGate.ProviderInstallationGate.of({
          execute: (gatedInstanceId, effect) =>
            Effect.sync(() => log.push(`enter ${gatedInstanceId}`)).pipe(
              Effect.andThen(effect),
              Effect.ensuring(Effect.sync(() => log.push("exit"))),
            ),
          update: () => Effect.die("unused"),
        }),
        queryRunner: {
          allocateSessionId: Effect.succeed("native-thread-claude-gate"),
          open: () =>
            Effect.sync(() => {
              log.push("open query");
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
              } satisfies ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      }).pipe(Effect.provideService(McpSessionRegistry.McpSessionRegistry, unusedRegistry));
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-gate-cwd-" }),
      });
      const threadId = ThreadId.make("thread-claude-gate");
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-claude-gate"),
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy,
      });
      assert.deepStrictEqual(log, []);

      yield* runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId,
          providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-claude-gate"),
          text: "Hello",
          attachments: [],
          runtimePolicy,
        }),
      );

      assert.deepStrictEqual(log, [`enter ${instanceId}`, "open query", "exit"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          MemoryDerivedCache.layer,
          NodeServices.layer,
        ),
      ),
    ),
  ),
);
