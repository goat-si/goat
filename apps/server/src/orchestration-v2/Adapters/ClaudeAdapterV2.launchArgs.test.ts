// @effect-diagnostics nodeBuiltinImport:off - launch argument fixtures use Node paths
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    ...(input.nativeThreadHasTurns === undefined
      ? {}
      : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
  };
}

describe("ClaudeAdapterV2 append-system-prompt-file launch argument", () => {
  const startTurnWithLaunchArgs = Effect.fnUntraced(function* (launchArgs: string, cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: { ...DEFAULT_CLAUDE_SETTINGS, launchArgs },
      environment: {},
      attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-append-" }),
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed("native-thread-claude-append-file"),
        open: (input) =>
          Effect.sync(() => {
            opened.push(input.options);
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
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd,
    });
    const threadId = ThreadId.make("thread-claude-append-file");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-append-file"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy,
    });
    const exit = yield* runtime
      .startTurn(
        makeClaudeTestTurnInput({
          threadId,
          providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-claude-append-file"),
          text: "What is the sentinel?",
          attachments: [],
          runtimePolicy,
        }),
      )
      .pipe(Effect.exit);
    return { exit, opened };
  });

  const appendSystemPrompt = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined) =>
    (options?.systemPrompt as { readonly append?: string } | undefined)?.append;

  it.effect("sends append launch arguments to Claude after the GOAT instructions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-claude-append-cwd-",
        });
        yield* fileSystem.writeFileString(NodePath.join(cwd, "rules.md"), "File sentinel\n");
        const plain = yield* startTurnWithLaunchArgs("", cwd);
        const { exit, opened } = yield* startTurnWithLaunchArgs(
          '--append-system-prompt "Inline sentinel" --append-system-prompt-file rules.md --system-prompt Replacement',
          cwd,
        );
        assert.isTrue(Exit.isSuccess(exit));
        assert.lengthOf(opened, 1);
        assert.equal(
          appendSystemPrompt(opened[0]),
          `${appendSystemPrompt(plain.opened[0])}\n\nFile sentinel\n\nInline sentinel`,
        );
        assert.isUndefined(opened[0]!.extraArgs?.["append-system-prompt"]);
        assert.isUndefined(opened[0]!.extraArgs?.["append-system-prompt-file"]);
        assert.equal(opened[0]!.extraArgs?.["system-prompt"], "Replacement");
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );

  it.effect.each([
    `--settings '{"skillOverrides":{"lint":"off"},"showThinkingSummaries":false}'`,
    "--settings user-settings.json",
  ])("merges %s beneath GOAT settings", (launchArgs) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-settings-" });
        yield* fileSystem.writeFileString(
          NodePath.join(cwd, "user-settings.json"),
          '{"skillOverrides":{"lint":"off"},"showThinkingSummaries":false}',
        );
        const { exit, opened } = yield* startTurnWithLaunchArgs(launchArgs, cwd);
        assert.isTrue(Exit.isSuccess(exit));
        assert.deepInclude(opened[0]!.settings, {
          skillOverrides: { lint: "off" },
          showThinkingSummaries: true,
        });
        assert.isUndefined(opened[0]!.extraArgs?.["settings"]);
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );

  it.effect.each([
    "--settings",
    "--settings=",
    "--settings missing.json",
    `--settings '{not json}'`,
    `--settings '{"env":{"SECRET":"settings-secret"},'`,
  ])("rejects invalid settings before opening Claude: %s", (launchArgs) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-settings-" });
        const { exit, opened } = yield* startTurnWithLaunchArgs(launchArgs, cwd);
        assert.lengthOf(opened, 0);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          const message = makeProviderFailure({
            cause: exit.cause,
            class: "provider_error",
          }).message;
          assert.include(message, "--settings");
          assert.notInclude(message, "settings-secret");
        }
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );

  // regression: #20413 malformed append-system-prompt launch args fail before a query opens
  it.effect.each([
    [
      "--append-system-prompt-file missing.md",
      (cwd: string) =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptFileError({
          path: NodePath.join(cwd, "missing.md"),
        }).message,
    ],
    [
      "--append-system-prompt-file",
      () =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptMissingValueError({
          flag: "--append-system-prompt-file",
        }).message,
    ],
    [
      "--append-system-prompt-file=",
      () =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptMissingValueError({
          flag: "--append-system-prompt-file",
        }).message,
    ],
    [
      "--append-system-prompt",
      () =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptMissingValueError({
          flag: "--append-system-prompt",
        }).message,
    ],
  ] as const)("fails the turn before opening Claude for %s", ([launchArgs, expectedMessage]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-claude-append-cwd-",
        });
        const { exit, opened } = yield* startTurnWithLaunchArgs(launchArgs, cwd);
        assert.lengthOf(opened, 0);
        assert.isTrue(Exit.isFailure(exit));
        if (!Exit.isFailure(exit)) return;
        assert.equal(
          makeProviderFailure({ cause: exit.cause, class: "provider_error" }).message,
          expectedMessage(cwd),
        );
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});
