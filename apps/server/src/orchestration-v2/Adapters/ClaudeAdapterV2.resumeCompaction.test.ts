import { ClaudeSettings, ProviderSessionId, RunAttemptId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { formatClaudeResumeCompactionQuestion } from "@goat/shared/claudeCompaction";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import {
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
} from "./ClaudeTestInput.testkit.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  resolveSettings: vi.fn().mockResolvedValue({ effective: {}, provenance: {}, sources: [] }),
}));

const layerAdapterTest = layerClaudeAdapterTest;
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

describe("ClaudeAdapterV2 resume compaction", () => {
  it.effect("resolves and cancels the SDK resume dialog through structured runtime input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-claude-resume-",
        });
        let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-resume"),
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
        const threadId = ThreadId.make("thread-claude-resume");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-resume"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-resume"),
            text: "continue",
            attachments: [],
          }),
        );
        const callback = openedOptions?.onUserDialog;
        assert.isFunction(callback);
        const canUseTool = openedOptions?.canUseTool;
        assert.isFunction(canUseTool);
        const longQuestion = `Choose a deployment target: ${"region ".repeat(80)}`;
        const questionRequestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const questionResult = yield* Effect.promise(() =>
          canUseTool!(
            "AskUserQuestion",
            {
              questions: [
                {
                  header: "Target",
                  question: longQuestion,
                  options: [
                    { label: "Production", description: "Deploy to production." },
                    { label: "Staging", description: "Deploy to staging." },
                  ],
                  multiSelect: true,
                },
              ],
            },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-question-full-access",
              requestId: "request-question-full-access",
            },
          ),
        ).pipe(Effect.forkScoped);
        const questionEvent = yield* Fiber.join(questionRequestEvent);
        assert.isTrue(Option.isSome(questionEvent));
        if (
          Option.isNone(questionEvent) ||
          questionEvent.value.type !== "runtime_request.updated"
        ) {
          return;
        }
        yield* runtime.respondToRuntimeRequest({
          requestId: questionEvent.value.runtimeRequest.id,
          answers: { [longQuestion]: ["Production", "Staging"] },
        });
        assert.deepEqual(yield* Fiber.join(questionResult), {
          behavior: "allow",
          updatedInput: {
            questions: [
              {
                header: "Target",
                question: longQuestion,
                options: [
                  { label: "Production", description: "Deploy to production." },
                  { label: "Staging", description: "Deploy to staging." },
                ],
                multiSelect: true,
              },
            ],
            answers: { [longQuestion]: "Production, Staging" },
          },
          toolUseID: "tool-question-full-access",
        });
        const longPlan = `# Deployment plan\n\n${"Validate every region before promotion.\n".repeat(120)}`;
        const proposedPlanEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "plan.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const exitPlanResult = yield* Effect.promise(() =>
          canUseTool!(
            "ExitPlanMode",
            { plan: longPlan },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-exit-plan-full-access",
              requestId: "request-exit-plan-full-access",
            },
          ),
        );
        assert.deepEqual(exitPlanResult, {
          behavior: "deny",
          message:
            "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          toolUseID: "tool-exit-plan-full-access",
        });
        const planEvent = yield* Fiber.join(proposedPlanEvent);
        assert.isTrue(Option.isSome(planEvent));
        if (Option.isSome(planEvent) && planEvent.value.type === "plan.updated") {
          assert.equal(planEvent.value.plan.kind, "proposed_plan");
          if (planEvent.value.plan.kind === "proposed_plan") {
            assert.equal(planEvent.value.plan.markdown, longPlan.trim());
          }
        }
        const requestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const signal = yield* Effect.abortSignal;
        const dialog = yield* Effect.promise(() =>
          callback!(
            {
              dialogKind: "resume_return",
              payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
            },
            { signal, requestId: "dialog-resume-1" },
          ),
        ).pipe(Effect.forkScoped);
        const event = yield* Fiber.join(requestEvent);
        assert.isTrue(Option.isSome(event));
        if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;
        const question = formatClaudeResumeCompactionQuestion({
          ageMinutes: 90,
          estimatedTokens: 120000,
        });
        yield* runtime.respondToRuntimeRequest({
          requestId: event.value.runtimeRequest.id,
          answers: { [question]: "Compact and continue" },
        });
        assert.deepEqual(yield* Fiber.join(dialog), { behavior: "completed", result: "compact" });

        assert.deepEqual(
          yield* Effect.promise(() =>
            callback!(
              {
                dialogKind: "resume_return",
                payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
              },
              { signal: AbortSignal.abort(), requestId: "dialog-resume-2" },
            ),
          ),
          { behavior: "cancelled" },
        );
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});

describe("ClaudeAdapterV2 resumeThread", () => {
  it.effect("fails for a transcript without messages so a fresh session replaces it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-claude-empty-session-",
        });
        const projectDir = path.join(configDir, "projects", "-workspace");
        yield* fileSystem.makeDirectory(projectDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(projectDir, "native-thread-empty.jsonl"),
          [
            `{"type":"last-prompt","lastPrompt":"hello","sessionId":"native-thread-empty"}`,
            `{"type":"atis-latch","atis":"","sessionId":"native-thread-empty"}`,
            `{"type":"cost-state","sessionId":"native-thread-empty","totalCostUSD":0}`,
            "",
          ].join("\n"),
        );
        yield* fileSystem.writeFileString(
          path.join(projectDir, "native-thread-saved.jsonl"),
          `{"type":"user","message":{"role":"user","content":"hello"},"sessionId":"native-thread-saved"}\n`,
        );
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: configDir },
          attachmentsDir: configDir,
          fileSystem,
          path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-empty"),
            open: () => Effect.die("unused"),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-empty-session");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-empty-session"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });

        const error = yield* Effect.flip(runtime.resumeThread({ providerThread }));
        assert.equal(error._tag, "ProviderAdapterResumeThreadError");

        const saved = yield* runtime.resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeId: "native-thread-saved",
              strength: "strong",
            },
          },
        });
        assert.equal(saved.nativeThreadRef?.nativeId, "native-thread-saved");

        const missing = yield* runtime.resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeId: "native-thread-missing",
              strength: "strong",
            },
          },
        });
        assert.equal(missing.nativeThreadRef?.nativeId, "native-thread-missing");
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );
});
