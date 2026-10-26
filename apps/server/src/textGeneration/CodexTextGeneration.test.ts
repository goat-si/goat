import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";
import { ChildProcessSpawner } from "effect/process";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { createModelSelection } from "@goat/shared/model";
import { expect } from "vite-plus/test";

import { CodexSettings, ProviderInstanceId, ProviderSetupError } from "@goat/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import * as Hold from "../memory/MemoryGenerationHold.ts";
import { writeFakeCli } from "@goat/provider-testing/fakeCli";
import { strictOutputSchemaViolations } from "@goat/provider-core/server/strictOutputSchema";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const isSetupError = Schema.is(ProviderSetupError);

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const layerCodexTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakeCodexInput {
  lifecycle?: { port: number; command: "exec" | "mcp list" };
  isolated?: boolean;
  output: string;
  exitCode?: number;
  stderr?: string;
  requireImage?: boolean;
  requireServiceTier?: string;
  requireReasoningEffort?: string;
  forbidReasoningEffort?: boolean;
  requireArg?: string;
  forbidArg?: string;
  stdinMustContain?: string;
  stdinMustNotContain?: string;
  /** Fail if `CODEX_HOME` holds an AGENTS.md, then rotate its auth.json as a token refresh would. */
  refreshAuth?: "in-place" | "replace";
  mcpServers?: ReadonlyArray<{ name: string; enabled: boolean }> | number;
  /** Copies the `--output-schema` file here so a test can check what the CLI received. */
  schemaCopyPath?: string;
}

function makeFakeCodexBinary(dir: string, input: FakeCodexInput) {
  const check = JSON.stringify({
    isolated: input.isolated ?? false,
    requireImage: input.requireImage ?? false,
    requireServiceTier: input.requireServiceTier ?? null,
    requireReasoningEffort: input.requireReasoningEffort ?? null,
    forbidReasoningEffort: input.forbidReasoningEffort ?? false,
    requireArg: input.requireArg ?? null,
    forbidArg: input.forbidArg ?? null,
    stdinMustContain: input.stdinMustContain ?? null,
    stdinMustNotContain: input.stdinMustNotContain ?? null,
    refreshAuth: input.refreshAuth ?? null,
    mcpServers: input.mcpServers ?? [],
    schemaCopyPath: input.schemaCopyPath ?? null,
    stderr: input.stderr ?? null,
    output: input.output,
    exitCode: input.exitCode ?? 0,
  });
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return writeFakeCli({
      directory: path.join(dir, "bin"),
      name: "codex",
      source: [
        'import * as NodeFS from "node:fs";',
        `const check = ${check};`,
        "const args = process.argv.slice(2);",
        ...(input.lifecycle === undefined
          ? []
          : [
              `if ((args.includes("mcp") && args.includes("list")) === ${input.lifecycle.command === "mcp list"}) {`,
              'process.on("SIGTERM", () => {});',
              processProbeSource(input.lifecycle.port),
              "await new Promise(() => {});",
              "}",
            ]),
        "if (check.isolated) {",
        "  const home = process.env.CODEX_HOME;",
        '  if (!home || home.includes(".codex")) process.exit(31);',
        "  if (NodeFS.readdirSync(process.cwd()).length !== 0) process.exit(32);",
        '  if (NodeFS.readdirSync(home).some((name) => name !== "auth.json")) process.exit(33);',
        "}",

        'if (args.includes("mcp") && args.includes("list")) {',
        '  if (typeof check.mcpServers === "number") process.exit(check.mcpServers);',
        "  process.stdout.write(JSON.stringify(check.mcpServers));",
        "  process.exit(0);",
        "}",
        'const originalArgs = ` ${args.join(" ")} `;',
        "let outputPath = null;",
        "let schemaPath = null;",
        "let seenImage = false;",
        'let seenServiceTier = "";',
        'let seenReasoningEffort = "";',
        "for (let index = 0; index < args.length; index += 1) {",
        '  if (args[index] === "--image") {',
        "    index += 1;",
        "    if (args[index]) seenImage = true;",
        '  } else if (args[index] === "--config") {',
        "    index += 1;",
        '    const value = args[index] ?? "";',
        '    if (value.startsWith("service_tier=")) seenServiceTier = value;',
        '    if (value.startsWith("model_reasoning_effort=")) seenReasoningEffort = value;',
        '  } else if (args[index] === "--output-last-message") {',
        "    index += 1;",
        "    outputPath = args[index] ?? null;",
        '  } else if (args[index] === "--output-schema") {',
        "    index += 1;",
        "    schemaPath = args[index] ?? null;",
        "  }",
        "}",
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        'const stdinContent = Buffer.concat(chunks).toString("utf8");',
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        // Codex CLI 0.163.0 forwards the schema to the API, which rejects a non-object root.
        "if (schemaPath !== null) {",
        '  const schema = JSON.parse(NodeFS.readFileSync(schemaPath, "utf8"));',
        "  if (check.schemaCopyPath !== null) NodeFS.copyFileSync(schemaPath, check.schemaCopyPath);",
        '  if (schema.type !== "object")',
        "    fail(",
        "      `Invalid schema for response_format 'codex_output_schema': schema must be a JSON Schema of 'type: \"object\"', got 'type: \"${schema.type ?? \"None\"}\"'.`,",
        "      1,",
        "    );",
        "}",
        "if (check.requireArg !== null && !originalArgs.includes(` ${check.requireArg} `)) {",
        '  fail("missing arg: " + check.requireArg, 8);',
        "}",
        "if (check.forbidArg !== null && originalArgs.includes(` ${check.forbidArg} `)) {",
        '  fail("forbidden arg: " + check.forbidArg, 9);',
        "}",
        'if (check.requireImage && !seenImage) fail("missing --image input", 2);',
        "if (",
        "  check.requireServiceTier !== null &&",
        '  seenServiceTier !== `service_tier="${check.requireServiceTier}"`',
        ") {",
        '  fail("unexpected service tier config: " + seenServiceTier, 5);',
        "}",
        "if (",
        "  check.requireReasoningEffort !== null &&",
        '  seenReasoningEffort !== `model_reasoning_effort="${check.requireReasoningEffort}"`',
        ") {",
        '  fail("unexpected reasoning effort config: " + seenReasoningEffort, 6);',
        "}",
        "if (check.forbidReasoningEffort && seenReasoningEffort.length > 0) {",
        '  fail("reasoning effort config should be omitted: " + seenReasoningEffort, 7);',
        "}",
        "if (check.stdinMustContain !== null && !stdinContent.includes(check.stdinMustContain)) {",
        '  fail("stdin missing expected content", 3);',
        "}",
        "if (check.stdinMustNotContain !== null && stdinContent.includes(check.stdinMustNotContain)) {",
        '  fail("stdin contained forbidden content", 4);',
        "}",
        "if (check.refreshAuth !== null) {",
        "  const home = process.env.CODEX_HOME;",
        '  if (NodeFS.existsSync(home + "/AGENTS.md")) fail("user AGENTS.md is visible", 10);',
        '  const auth = NodeFS.readFileSync(home + "/auth.json", "utf8");',
        '  const rotated = auth.replace("refresh-1", "refresh-2");',
        '  if (check.refreshAuth === "in-place") NodeFS.writeFileSync(home + "/auth.json", rotated);',
        "  else {",
        '    NodeFS.writeFileSync(home + "/auth.json.tmp", rotated);',
        '    NodeFS.renameSync(home + "/auth.json.tmp", home + "/auth.json");',
        "  }",
        "}",
        'if (check.stderr !== null) process.stderr.write(check.stderr + "\\n");',
        'if (outputPath !== null) NodeFS.writeFileSync(outputPath, check.output + "\\n");',
        "process.exitCode = check.exitCode;",
        "",
      ].join("\n"),
    });
  });
}

function withFakeCodexEnv<A, E, R>(
  input: FakeCodexInput & {
    launchArgs?: string;
    environment?: NodeJS.ProcessEnv;
    models?: ReadonlyArray<string>;
    managedRuntime?: boolean | ProviderSetupError;
    memoryRunnerContext?: import("@goat/provider-core/server/memoryGenerationRunner").MemoryGenerationRunnerContext;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = decodeCodexSettings({ binaryPath: codexPath, launchArgs: input.launchArgs });
    const textGeneration = yield* makeCodexTextGeneration(
      config,
      input.memoryRunnerContext
        ? { ...process.env, CODEX_HOME: tempDir, ...input.environment }
        : input.environment === undefined
          ? undefined
          : { ...process.env, ...input.environment },
      Effect.succeed(
        (input.models ?? []).map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
      ),
      isSetupError(input.managedRuntime)
        ? Effect.fail(input.managedRuntime)
        : input.managedRuntime
          ? Effect.succeed({
              config,
              environment: input.environment ?? process.env,
              revision: "test",
            })
          : undefined,
      input.memoryRunnerContext,
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

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
              : memoryOutput,
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
            expect(generated.result.text).toBe(memoryOutput.text);
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
        output: JSON.stringify(memoryOutput),
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
        output: JSON.stringify({
          ...memoryOutput,
          judgment: "Forged",
          execution: { effectiveModel: "forged" },
        }),
        memoryRunnerContext: memoryContext,
      },
      (generation) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            operation === "resolveMemoryConflict"
              ? generation.resolveMemoryConflict!(memoryConflict)
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
            ? generation.resolveMemoryConflict!(memoryConflict)
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
                ? generation.resolveMemoryConflict!(memoryConflict)
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
          '--config features.plugins=false --config features.apps=false --config mcp_servers={"augmenter"={enabled=false},"my.server"={enabled=false}}',
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
        launchArgs: "--strict-config --listen off",
        requireArg: "--strict-config",
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
          // Background fibers (e.g. the worktree branch rename fork) can run
          // after their launching request's scope has closed; temp files must
          // not be tied to that ambient scope or they are reaped on creation.
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
    replyText: "On it.",
    action: "create_task",
    title: "Re-verify the call",
    instruction: "Run the Opus 5.5 call again and report latency.",
    projectId: "project-1",
    host: "",
    taskId: "",
    questionId: "",
    answer: "",
    question: "",
    options: [],
    reads: [],
    remember: "",
    rememberQuote: "",
    notesChangeRequested: "",
    additionalTasks: [],
    clarifyAbout: "other",
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
