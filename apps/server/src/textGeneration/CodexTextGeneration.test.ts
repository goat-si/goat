import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import { makeProcessProbe } from "../testUtils/processProbe.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";
import * as M from "@goat/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { createModelSelection } from "@goat/shared/model";
import { expect } from "vite-plus/test";
import { ProviderInstanceId, ProviderSetupError } from "@goat/contracts";
import * as ServerConfig from "../config.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import * as Hold from "../memory/MemoryGenerationHold.ts";
import { EMPTY_CHANNEL_RECEPTION_MODEL_OUTPUT } from "@goat/provider-core/server/channelReceptionPrompt";
import { strictOutputSchemaViolations } from "@goat/provider-core/server/strictOutputSchema";
import {
  decodeCodexSettings,
  isSetupError,
  DEFAULT_TEST_MODEL_SELECTION,
  layerCodexTextGenerationTest,
  withFakeCodexEnv,
} from "./codexTextGenerationFake.testkit.ts";

const memorySelection = M.MemoryModelSelection.make({
  instanceId: M.ProviderInstanceId.make("codex"),
  model: "gpt-5.6-luna",
  options: [],
});
const memoryContext = {
  providerInstanceId: memorySelection.instanceId,
  environmentId: M.EnvironmentId.make("memory-owner"),
};
const memoryId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const memoryRevision = M.MemoryRevision.make({
  memorySpaceId: M.MemorySpaceId.make(memoryId(1)),
  memoryId: M.MemoryId.make(memoryId(2)),
  revisionId: M.MemoryRevisionId.make(memoryId(3)),
  payloadRef: M.MemoryRevisionId.make(memoryId(3)),
  operationId: M.MemoryOperationId.make(memoryId(4)),
  parents: [],
  scope: { kind: "user" },
  assertionKind: "inference",
  provenance: { environmentId: memoryContext.environmentId },
  createdAtUtc: "2026-10-14T00:00:00.000Z",
});
const memoryPayload = M.MemoryPayload.make({
  text: "Synthetic input",
  evidence: [],
  derivedFromMemoryRevisions: [],
});
const memorySummary = M.GenerateMemorySummaryInput.make({
  cwd: process.cwd(),
  sourceThread: {
    environmentId: memoryContext.environmentId,
    threadId: M.ThreadId.make("synthetic-thread"),
  },
  sourceWatermark: {
    fromEventId: M.EventId.make("e1"),
    toEventId: M.EventId.make("e2"),
    throughSequence: 2,
  },
  messages: [{ messageId: M.MessageId.make("m1"), text: "Synthetic input", completed: true }],
  modelSelection: memorySelection,
});
const memoryConflict = M.ResolveMemoryConflictInput.make({
  cwd: memorySummary.cwd,
  memorySpaceId: memoryRevision.memorySpaceId,
  memoryId: memoryRevision.memoryId,
  conflictId: M.MemoryConflictId.make(memoryId(8)),
  heads: [
    { revision: memoryRevision, payload: memoryPayload },
    {
      revision: {
        ...memoryRevision,
        revisionId: M.MemoryRevisionId.make(memoryId(5)),
        payloadRef: M.MemoryRevisionId.make(memoryId(5)),
      },
      payload: memoryPayload,
    },
  ],
  modelSelection: memorySelection,
});
const memoryOutput = { text: "Synthetic result", assertionKind: "inference", evidence: [] };
const memoryOperations = ["resolveMemoryConflict", "generateMemorySummary"] as const;

it.layer(layerCodexTextGenerationTest)("CodexTextGeneration", (it) => {
  it.effect.each(["stdout", "stderr", "mcp-list"] as const)(
    "rejects oversized finite %s before accepting generation",
    (outputStream) =>
      Effect.gen(function* () {
        const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        let drained = 0;
        const chunk = new Uint8Array(1024 * 1024).fill(32);
        const spawner = ChildProcessSpawner.make((command) =>
          nativeSpawner.spawn(command).pipe(
            Effect.map((child) => {
              if (
                !ChildProcess.isStandardCommand(command) ||
                !command.args.includes(outputStream === "mcp-list" ? "mcp" : "exec")
              )
                return child;
              return {
                ...child,
                [outputStream === "mcp-list" ? "stdout" : outputStream]: child[
                  outputStream === "mcp-list" ? "stdout" : outputStream
                ].pipe(
                  Stream.concat(
                    Stream.fromIterable(Array.from({ length: 9 }, () => chunk)).pipe(
                      Stream.tap(() =>
                        Effect.sync(() => {
                          drained++;
                        }),
                      ),
                    ),
                  ),
                ),
              };
            }),
          ),
        );
        const result = yield* withFakeCodexEnv(
          { output: JSON.stringify({ title: "Synthetic title" }) },
          (generation) =>
            generation
              .generateThreadTitle({
                cwd: process.cwd(),
                message: "Synthetic request",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.result),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        expect(drained).toBe(9);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.detail).toContain("Failed to collect process output");
      }),
  );

  it.effect.each(memoryOperations)("runs %s without tools or checkout configuration", (operation) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const schemaCopyPath = (yield* fs.makeTempDirectoryScoped()) + "/schema.json";
      yield* withFakeCodexEnv(
        {
          schemaCopyPath,
          output: JSON.stringify(
            operation === "resolveMemoryConflict"
              ? { ...memoryOutput, judgment: "Synthetic judgment" }
              : { summary: memoryOutput },
          ),
          memoryRunnerContext: memoryContext,
          models: ["openai.gpt-5.6-luna"],
          requireArg:
            "--ignore-user-config --ignore-rules --disable shell_tool --disable unified_exec --disable apps --disable plugins --disable browser_use --disable computer_use --disable view_image --disable hooks",
          isolated: true,
        },
        (generation) =>
          Effect.gen(function* () {
            const generated =
              operation === "resolveMemoryConflict"
                ? yield* generation.resolveMemoryConflict!(memoryConflict)
                : yield* generation.generateMemorySummary!(memorySummary);
            expect(generated.result).not.toBeNull();
            expect(generated.result?.text).toBe(memoryOutput.text);
            expect(generated.execution).toEqual({
              requestedModelSelection: memorySelection,
              effectiveModel: "openai.gpt-5.6-luna",
              effectiveProvider: "codex",
              providerInstanceId: memoryContext.providerInstanceId,
              environmentId: memoryContext.environmentId,
            });
          }),
      );
      // Codex CLI 0.163.0 sends this file as a strict response format; one broken rule fails the call.
      const schema: unknown = JSON.parse(yield* fs.readFileString(schemaCopyPath));
      expect(strictOutputSchemaViolations(schema)).toEqual([]);
    }).pipe(Effect.scoped),
  );
  it.effect("keeps a managed setup refusal as the cause so memory pauses the model", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ summary: memoryOutput }),
        memoryRunnerContext: memoryContext,
        managedRuntime: new ProviderSetupError({
          instanceId: memoryContext.providerInstanceId,
          operation: "managedRuntime",
          detail: "Sign in with ChatGPT to use managed Codex.",
        }),
      },
      (generation) =>
        Effect.gen(function* () {
          const error = yield* generation.generateMemorySummary!(memorySummary).pipe(Effect.flip);
          expect(error.detail).toBe("Sign in with ChatGPT to use managed Codex.");
          expect(isSetupError(error.cause)).toBe(true);
          expect(Hold.deterministicFailure(error)).toBe("unavailable");
        }),
    ),
  );
  it.effect.each(memoryOperations)("rejects forged execution JSON for %s", (operation) =>
    withFakeCodexEnv(
      {
        output: JSON.stringify(
          operation === "resolveMemoryConflict"
            ? {
                ...memoryOutput,
                judgment: "Forged",
                execution: { effectiveModel: "forged" },
              }
            : {
                summary: {
                  ...memoryOutput,
                  execution: { effectiveModel: "forged" },
                },
              },
        ),
        memoryRunnerContext: memoryContext,
      },
      (generation) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            operation === "resolveMemoryConflict"
              ? generation.resolveMemoryConflict!(memoryConflict).pipe(
                  Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome),
                )
              : generation.generateMemorySummary!(memorySummary),
          );
          expect(exit._tag).toBe("Failure");
        }),
    ),
  );
  it.effect.each(memoryOperations)(
    "memory isolation failure never spawns or falls back for %s",
    (operation) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-memory-auth-test-" });
        yield* fs.writeFileString(path.join(home, "auth.json"), "{}");
        let spawns = 0;
        const generation = yield* makeCodexTextGeneration(
          decodeCodexSettings({}),
          { CODEX_HOME: home },
          Effect.succeed([]),
          undefined,
          memoryContext,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            symlink: () => fs.readFile("/synthetic-missing-memory-auth-link").pipe(Effect.asVoid),
          }),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => {
              spawns++;
              return Effect.die("Unexpected spawn");
            }),
          ),
        );
        const error = yield* (
          operation === "resolveMemoryConflict"
            ? generation.resolveMemoryConflict!(memoryConflict).pipe(
                Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome),
              )
            : generation.generateMemorySummary!(memorySummary)
        ).pipe(Effect.flip);
        expect(error.detail).toContain("could not isolate");
        expect(spawns).toBe(0);
      }).pipe(Effect.scoped),
  );
  it.effect.each(memoryOperations)(
    "rejects mismatched bound instance before spawn for %s",
    (operation) =>
      withFakeCodexEnv(
        {
          output: "{}",
          memoryRunnerContext: {
            ...memoryContext,
            providerInstanceId: M.ProviderInstanceId.make("other-instance"),
          },
        },
        (generation) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              operation === "resolveMemoryConflict"
                ? generation.resolveMemoryConflict!(memoryConflict).pipe(
                    Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome),
                  )
                : generation.generateMemorySummary!(memorySummary),
            );
            expect(exit._tag).toBe("Failure");
          }),
      ),
  );

  it.effect.each(["exec", "mcp list"] as const)(
    "kills a stalled %s CLI when its request is interrupted",
    (command) =>
      Effect.gen(function* () {
        const probe = yield* makeProcessProbe;
        yield* withFakeCodexEnv(
          { output: "", lifecycle: { port: probe.port, command } },
          (textGeneration) =>
            Effect.gen(function* () {
              const fiber = yield* textGeneration
                .generateThreadTitle({
                  cwd: process.cwd(),
                  message: "Name this thread",
                  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
                })
                .pipe(Effect.forkScoped);
              yield* probe.started;

              const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
              yield* probe.exited;
              yield* Fiber.join(interrupted);
              const exit = yield* Fiber.await(fiber);
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            }),
        );
      }),
  );
  it.effect.each(["gpt-5.6-luna", "openai.gpt-5.6-luna"])(
    "dispatches the qualified live model for %s",
    (selectedModel) =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Bedrock title" }),
          models: ["openai.gpt-5.6-luna"],
          requireArg: "--model openai.gpt-5.6-luna",
          forbidArg: "--model gpt-5.6-luna",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Describe this change",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), selectedModel),
            });
            expect(result.title).toBe("Bedrock title");
          }),
      ),
  );

  it.effect("drops the requested model's options when falling back to another model", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Live title" }),
        models: ["gpt-6-astra"],
        requireArg: '--model gpt-6-astra --config model_reasoning_effort="low"',
        forbidArg: 'service_tier="priority"',
      },
      (textGeneration) =>
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Describe this change",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-luna", [
            { id: "reasoningEffort", value: "none" },
            { id: "serviceTier", value: "priority" },
          ]),
        }),
    ),
  );

  it.effect("sends a configured custom model the managed snapshot leaves out", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Live title" }),
        models: ["gpt-6-astra", "gpt-5.6-luna"],
        defaultModel: "gpt-6-astra",
        customModels: ["gpt-5.6-luna-preview"],
        managedRuntime: true,
        requireArg: '--model gpt-5.6-luna-preview --config model_reasoning_effort="high"',
      },
      (textGeneration) =>
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Describe this change",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex"),
            "gpt-5.6-luna-preview",
            [{ id: "reasoningEffort", value: "high" }],
          ),
        }),
    ),
  );

  it.effect("omits a persisted service tier for managed ChatGPT text generation", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Update project", body: "" }),
        managedRuntime: true,
        forbidArg: 'service_tier="priority"',
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/chatgpt",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "serviceTier", value: "priority" },
          ]),
        }),
    ),
  );

  it.effect("generates titles with the user's MCP servers and plugins off", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        mcpServers: [
          { name: "augmenter", enabled: true },
          { name: "my.server", enabled: true },
          { name: "already-off", enabled: false },
        ],
        requireArg:
          'exec --config mcp_servers={"augmenter"={enabled=false},"my.server"={enabled=false}} --config features.plugins=false',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Augmenter task 1. Use the Augmenter MCP: link_thread when you start.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("still generates when Codex cannot list its MCP servers", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "remove-default-shapes" }),
        mcpServers: 2,
        requireArg: "--config features.plugins=false --config features.apps=false --ephemeral",
        forbidArg: "mcp_servers=",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.branch).toBe("remove-default-shapes");
        }),
    ),
  );

  it.effect("keeps plugins and apps off over launch args that turn them on", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        launchArgs: "--config features.plugins=true --config features.apps=true",
        requireArg:
          "--config features.plugins=true --config features.apps=true --config features.plugins=false --config features.apps=false --ephemeral",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("passes exec-safe launch args into codex exec", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        launchArgs: "--strict-config --oss --local-provider ollama --listen off",
        requireArg: "--strict-config --oss --local-provider ollama",
        forbidArg: "--listen",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("generates branch names even when the ambient scope is already closed", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "feat/background-generation",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          // Background fibers can outlive request scopes; temp files scoped there would be reaped on creation.
          const closedScope = yield* Scope.make();
          yield* Scope.close(closedScope, Exit.void);

          const generated = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Please update session handling.",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.provideService(Scope.Scope, closedScope));

          expect(generated.branch).toBe("feat/background-generation");
        }),
    ),
  );

  it.effect("returns the refinement signal for an unresolved subject", () =>
    withFakeCodexEnv(
      { output: JSON.stringify({ title: "Investigate issue", needsRefinement: true }) },
      (textGeneration) =>
        Effect.gen(function* () {
          expect(
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix this",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
          ).toEqual({ title: "Investigate issue", needsRefinement: true });
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-1-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.ignore)),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );
});

it.layer(layerCodexTextGenerationTest)("channel reception", (it) => {
  const receptionOutput = JSON.stringify({
    ...EMPTY_CHANNEL_RECEPTION_MODEL_OUTPUT,
    replyText: "On it.",
    action: "create_task",
    title: "Re-verify the call",
    instruction: "Run the Opus 5.5 call again and report latency.",
    projectId: "project-1",
  });
  const receptionInput = {
    mode: "input" as const,
    conversationId: "conv-1" as never,
    originKind: "slack" as const,
    inputText: "Please re-verify the Opus 5.5 call",
    tail: [],
    tasks: [],
    allowedTargets: [{ projectId: "project-1" as never, label: "GOAT" }],
    requester: {
      ownerId: "owner",
      principalId: "owner",
      displayName: "Jun",
      originKind: "slack" as const,
      runtimeModeCeiling: "full-access" as const,
      grantedScopes: ["orchestration:operate" as const],
    },
  };

  it.effect("runs reception with user config, rules, and tools turned off", () =>
    withFakeCodexEnv(
      {
        output: receptionOutput,
        requireArg:
          "--ignore-user-config --ignore-rules --disable shell_tool --disable unified_exec",
        stdinMustContain: "Please re-verify the Opus 5.5 call",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateChannelReception;
          expect(generate).toBeDefined();
          if (generate === undefined) return;
          const result = yield* generate({
            cwd: process.cwd(),
            input: receptionInput,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result).toEqual({
            replyText: "On it.",
            action: {
              type: "create_task",
              title: "Re-verify the call",
              instruction: "Run the Opus 5.5 call again and report latency.",
              projectId: "project-1",
            },
          });
        }),
    ),
  );

  it.effect("leaves configured launch args out of reception", () =>
    withFakeCodexEnv(
      { output: receptionOutput, launchArgs: "--strict-config", forbidArg: "--strict-config" },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateChannelReception;
          if (generate === undefined) return yield* Effect.die("reception missing");
          yield* generate({
            cwd: process.cwd(),
            input: receptionInput,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
        }),
    ),
  );

  it.effect("fails when the model picks an action without its fields", () =>
    withFakeCodexEnv(
      { output: JSON.stringify({ ...JSON.parse(receptionOutput), title: "" }) },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateChannelReception;
          if (generate === undefined) return yield* Effect.die("reception missing");
          const error = yield* Effect.flip(
            generate({
              cwd: process.cwd(),
              input: receptionInput,
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
          );
          expect(error.operation).toBe("generateChannelReception");
        }),
    ),
  );

  it.effect.each(["in-place", "replace"] as const)(
    "hides the user's AGENTS.md and keeps a %s token refresh in the user's auth.json",
    (refreshAuth) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-user-home-" });
        yield* fs.writeFileString(path.join(userHome, "AGENTS.md"), "Reply in Korean.");
        yield* fs.writeFileString(path.join(userHome, "auth.json"), '{"refresh":"refresh-1"}');
        yield* withFakeCodexEnv(
          { output: receptionOutput, refreshAuth, environment: { CODEX_HOME: userHome } },
          (textGeneration) =>
            Effect.gen(function* () {
              const generate = textGeneration.generateChannelReception;
              if (generate === undefined) return yield* Effect.die("reception missing");
              yield* generate({
                cwd: process.cwd(),
                input: receptionInput,
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              });
            }),
        );
        expect(yield* fs.readFileString(path.join(userHome, "auth.json"))).toBe(
          '{"refresh":"refresh-2"}',
        );
        expect(yield* fs.readFileString(path.join(userHome, "AGENTS.md"))).toBe("Reply in Korean.");
      }).pipe(Effect.scoped),
  );
});
