import { processProbeSource } from "../testUtils/processProbe.ts";
import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { createModelSelection } from "@goat/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
} from "../provider/ClaudeModelCatalog.testFixtures.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "@goat/provider-core/server/textGenerationUtils";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { ClaudeMemoryRegistryQuery, verifyClaudeMemoryHooks } from "./ClaudeMemoryIsolation.ts";
import { writeFakeCli } from "@goat/provider-testing/fakeCli";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const layerClaudeTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The stub behaviour lives in Node so the same implementation runs on Windows,
// where a shebang file is not executable and would fall through to the real
// Claude CLI on PATH; `writeFakeCli` picks the launcher shape per host.
function makeFakeClaudeBinary(dir: string, lifecyclePort?: number) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const binDir = path.join(dir, "bin");
    const fixturePath = yield* path.fromFileUrl(
      new URL("./testing/ClaudeTextGeneration.fixture.mjs", import.meta.url),
    );
    const source = yield* fs.readFileString(fixturePath);
    writeFakeCli({
      directory: binDir,
      name: "claude",
      platform,
      source:
        lifecyclePort === undefined
          ? source
          : `process.on("SIGTERM", () => {}); ${processProbeSource(lifecyclePort)}`,
    });
    return binDir;
  });
}

const registryOutput = (key: string, settings: string, type = "REG_SZ") =>
  `\n${key.replace("HKLM", "HKEY_LOCAL_MACHINE").replace("HKCU", "HKEY_CURRENT_USER")}\n    Settings    ${type}    ${settings}\n`;
const emptyRegistryQuery = (key: string) => Effect.succeed(registryOutput(key, "{}"));

function withFakeClaudeEnv<A, E, R>(
  input: {
    memoryRunnerContext?: import("@goat/provider-core/server/memoryGenerationRunner").MemoryGenerationRunnerContext;
    output: string;
    managedSettings?: string;
    managedDropin?: string;
    managedUnreadable?: boolean;
    subscription?: boolean;
    oauthToken?: boolean;
    wsl?: boolean;
    platform?: NodeJS.Platform;
    registryQuery?: (key: string) => Effect.Effect<string, MemoryGenerationRunnerError>;
    expectNoSpawn?: boolean;
    expectSpawn?: boolean;
    directApi?: boolean;
    defaultEndpoint?: boolean;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    cwdMustNotBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const pathDelimiter = (yield* HostProcess.isWindows) ? ";" : ":";
    const previousPath = process.env.PATH;
    const previousOutput = process.env.GOAT_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.GOAT_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.GOAT_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.GOAT_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.GOAT_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.GOAT_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousConfigDirMustBe = process.env.GOAT_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
    const previousCwdMustNotBe = process.env.GOAT_FAKE_CLAUDE_CWD_MUST_NOT_BE;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}${pathDelimiter}${previousPath ?? ""}`;
        process.env.GOAT_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.GOAT_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.GOAT_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.GOAT_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.GOAT_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.GOAT_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.GOAT_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.GOAT_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.GOAT_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.GOAT_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.GOAT_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.cwdMustNotBe !== undefined) {
          process.env.GOAT_FAKE_CLAUDE_CWD_MUST_NOT_BE = input.cwdMustNotBe;
        } else {
          delete process.env.GOAT_FAKE_CLAUDE_CWD_MUST_NOT_BE;
        }

        if (input.configDirMustBe !== undefined) {
          process.env.GOAT_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = input.configDirMustBe;
        } else {
          delete process.env.GOAT_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.GOAT_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.GOAT_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.GOAT_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.GOAT_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.GOAT_FAKE_CLAUDE_STDERR;
          } else {
            process.env.GOAT_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.GOAT_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.GOAT_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.GOAT_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.GOAT_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.GOAT_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.GOAT_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousCwdMustNotBe === undefined) {
            delete process.env.GOAT_FAKE_CLAUDE_CWD_MUST_NOT_BE;
          } else {
            process.env.GOAT_FAKE_CLAUDE_CWD_MUST_NOT_BE = previousCwdMustNotBe;
          }

          if (previousConfigDirMustBe === undefined) {
            delete process.env.GOAT_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
          } else {
            process.env.GOAT_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = previousConfigDirMustBe;
          }
        }),
    );

    const config = decodeClaudeSettings({
      ...(input.memoryRunnerContext ? { homePath: tempDir } : {}),
      ...input.claudeConfig,
    });
    const textGeneration = yield* makeClaudeTextGeneration(
      config,
      input.memoryRunnerContext === undefined
        ? undefined
        : {
            ...process.env,
            ANTHROPIC_API_KEY: input.subscription ? "" : "synthetic-api-key",
            ANTHROPIC_AUTH_TOKEN: "",
            ANTHROPIC_BASE_URL: input.defaultEndpoint
              ? undefined
              : input.directApi
                ? "https://api.anthropic.com"
                : "https://synthetic-provider.invalid",
            GOAT_FAKE_CLAUDE_SPAWN_MARKER: `${tempDir}/spawned`,
            CLAUDE_CODE_OAUTH_TOKEN: input.oauthToken ? "synthetic-oauth-token" : "",
            CLAUDE_CODE_USE_BEDROCK: "",
            CLAUDE_CODE_USE_VERTEX: "",
            CLAUDE_CODE_USE_FOUNDRY: "",
            WSL_DISTRO_NAME: input.wsl ? "synthetic-wsl" : "",
          },
      Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
      input.memoryRunnerContext,
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        exists: (file) =>
          file.endsWith("managed-settings.json")
            ? Effect.succeed(
                input.managedSettings !== undefined || input.managedUnreadable === true,
              )
            : file.endsWith("managed-settings.d") || file.endsWith("10-hooks.json")
              ? Effect.succeed(input.managedDropin !== undefined)
              : file.startsWith("/Library/") ||
                  file.startsWith("/etc/claude-code") ||
                  file.startsWith("/mnt/c/Program Files/ClaudeCode")
                ? Effect.succeed(false)
                : fs.exists(file),
        readDirectory: (file) =>
          file.endsWith("managed-settings.d")
            ? Effect.succeed(["10-hooks.json"])
            : fs.readDirectory(file),
        readFileString: (file, encoding) =>
          file.endsWith("managed-settings.json")
            ? input.managedUnreadable
              ? Effect.fail(
                  new PlatformError.SystemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readFileString",
                    pathOrDescriptor: file,
                  }),
                )
              : Effect.succeed(input.managedSettings ?? "{}")
            : file.endsWith("10-hooks.json")
              ? Effect.succeed(input.managedDropin ?? "{}")
              : fs.readFileString(file, encoding),
      }),
      Effect.provideService(HostProcess.Platform, input.platform ?? "linux"),
    );
    const result = yield* effectFn(textGeneration);
    if (input.expectNoSpawn) expect(yield* fs.exists(`${tempDir}/spawned`)).toBe(false);
    if (input.expectSpawn) expect(yield* fs.exists(`${tempDir}/spawned`)).toBe(true);
    return result;
  }).pipe(
    Effect.provideService(ClaudeMemoryRegistryQuery, input.registryQuery ?? emptyRegistryQuery),
    Effect.scoped,
  );
}

const memorySelection = M.MemoryModelSelection.make({
  instanceId: M.ProviderInstanceId.make("claudeAgent"),
  model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
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

it.layer(layerClaudeTextGenerationTest)("ClaudeTextGeneration", (it) => {
  it.effect.each(memoryOperations)(
    "records the resolved Claude alias and option suffix for %s",
    (operation) =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output:
              operation === "resolveMemoryConflict"
                ? { ...memoryOutput, judgment: "Synthetic" }
                : memoryOutput,
          }),
          memoryRunnerContext: memoryContext,
          argsMustContain: `--model ${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded] --effort high`,
        },
        (generation) =>
          Effect.gen(function* () {
            const selection = M.MemoryModelSelection.make({
              ...memorySelection,
              model: SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
              options: [
                { id: "contextWindow", value: "expanded" },
                { id: "effort", value: "high" },
              ],
            });
            const generated =
              operation === "resolveMemoryConflict"
                ? yield* generation.resolveMemoryConflict!({
                    ...memoryConflict,
                    modelSelection: selection,
                  })
                : yield* generation.generateMemorySummary!({
                    ...memorySummary,
                    modelSelection: selection,
                  });
            expect(generated.execution.effectiveModel).toBe(
              `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`,
            );
            expect(generated.execution.requestedModelSelection).toEqual(selection);
          }),
      ),
  );

  it.effect.each(
    memoryOperations.flatMap((operation) =>
      [
        {
          scenario: "managed SessionStart hook",
          managedSettings: JSON.stringify({
            hooks: { SessionStart: [{ hooks: [{ type: "command", command: "synthetic" }] }] },
          }),
        },
        {
          scenario: "managed UserPromptSubmit drop-in",
          managedDropin: JSON.stringify({ hooks: { UserPromptSubmit: [] } }),
        },
        { scenario: "unreadable policy", managedUnreadable: true },
        { scenario: "invalid policy", managedSettings: "{invalid" },
      ].map((scenario) => ({ operation, ...scenario })),
    ),
  )(
    "$operation refuses $scenario before accepting apparent success",
    ({ operation, ...scenario }) =>
      withFakeClaudeEnv(
        {
          ...scenario,
          directApi: true,
          expectNoSpawn: true,
          memoryRunnerContext: memoryContext,
          output: JSON.stringify({
            structured_output:
              operation === "resolveMemoryConflict"
                ? { ...memoryOutput, judgment: "Synthetic" }
                : memoryOutput,
          }),
        },
        (generation) =>
          Effect.gen(function* () {
            const failure = yield* Effect.flip(
              operation === "resolveMemoryConflict"
                ? generation.resolveMemoryConflict!(memoryConflict)
                : generation.generateMemorySummary!(memorySummary),
            );
            expect(failure.cause).toMatchObject({ code: "unavailable" });
          }),
      ),
  );

  it.effect.each(
    memoryOperations.flatMap((operation) =>
      [
        { scenario: "default Anthropic API", directApi: true },
        { scenario: "API key without endpoint override", defaultEndpoint: true },
        { scenario: "subscription login", subscription: true, directApi: true },
        {
          scenario: "subscription OAuth token",
          subscription: true,
          oauthToken: true,
          directApi: true,
        },
        { scenario: "WSL without Windows policy", wsl: true, directApi: true },
        {
          scenario: "hook-free managed file and drop-in",
          managedSettings: "{}",
          managedDropin: "{}",
          directApi: true,
        },
      ].map((scenario) => ({ operation, ...scenario })),
    ),
  )("$operation allows $scenario after local inspection", ({ operation, ...scenario }) =>
    withFakeClaudeEnv(
      {
        ...scenario,
        expectSpawn: true,
        memoryRunnerContext: memoryContext,
        output: JSON.stringify({
          structured_output:
            operation === "resolveMemoryConflict"
              ? { ...memoryOutput, judgment: "Synthetic" }
              : memoryOutput,
        }),
      },
      (generation) =>
        Effect.gen(function* () {
          const generated =
            operation === "resolveMemoryConflict"
              ? yield* generation.resolveMemoryConflict!(memoryConflict)
              : yield* generation.generateMemorySummary!(memorySummary);
          expect(generated.result.text).toBe(memoryOutput.text);
        }),
    ),
  );

  it.effect.each([
    { platform: "win32", system: "C:\\Program Files\\ClaudeCode" },
    { platform: "darwin", system: "/Library/Application Support/ClaudeCode" },
    { platform: "linux", system: "/etc/claude-code" },
  ] as const)("allows absent local policy on $platform", ({ platform, system }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inspected: string[] = [];
      yield* verifyClaudeMemoryHooks("generateMemorySummary", {}).pipe(
        Effect.provideService(ClaudeMemoryRegistryQuery, emptyRegistryQuery),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (file) => {
            inspected.push(file);
            return Effect.succeed(false);
          },
        }),
      );
      expect(inspected).toContain(path.join(system, "managed-settings.json"));
      expect(inspected).toContain(path.join(system, "managed-settings.d"));
    }),
  );

  it.effect.each([
    {
      platform: "darwin",
      policy: "/Library/Managed Preferences/com.anthropic.claudecode.plist",
      environment: {},
    },
    {
      platform: "linux",
      policy: "/mnt/c/Program Files/ClaudeCode/managed-settings.json",
      environment: { WSL_DISTRO_NAME: "synthetic-wsl" },
    },
  ] as const)(
    "refuses a present uninspectable $platform policy",
    ({ platform, policy, environment }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const failure = yield* Effect.flip(
          verifyClaudeMemoryHooks("generateMemorySummary", environment).pipe(
            Effect.provideService(ClaudeMemoryRegistryQuery, emptyRegistryQuery),
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              exists: (file) => Effect.succeed(file === policy),
            }),
          ),
        );
        expect(failure.cause).toMatchObject({ code: "unavailable" });
      }),
  );

  it.effect.each(
    memoryOperations.flatMap((operation) =>
      ["win32", "wsl"].flatMap((host) =>
        [
          "HKLM hook",
          "HKCU hook",
          "query failure",
          "interop unavailable",
          "invalid JSON",
          "invalid type",
          "invalid framing",
        ].map((scenario) => ({ operation, host, scenario })),
      ),
    ),
  )("$operation refuses $host registry $scenario before spawn", ({ operation, host, scenario }) =>
    withFakeClaudeEnv(
      {
        platform: host === "win32" ? "win32" : "linux",
        wsl: host === "wsl",
        memoryRunnerContext: memoryContext,
        expectNoSpawn: true,
        output: JSON.stringify({
          structured_output:
            operation === "resolveMemoryConflict"
              ? { ...memoryOutput, judgment: "Synthetic" }
              : memoryOutput,
        }),
        registryQuery: (key) => {
          if (scenario === "query failure" || scenario === "interop unavailable")
            return Effect.fail(new MemoryGenerationRunnerError({ code: "unavailable" }));
          if (scenario === "invalid framing") return Effect.succeed("unexpected response");
          if (scenario === "invalid JSON") return Effect.succeed(registryOutput(key, "{invalid"));
          if (scenario === "invalid type")
            return Effect.succeed(registryOutput(key, "{}", "REG_BINARY"));
          const hooks = key.startsWith(scenario.startsWith("HKLM") ? "HKLM" : "HKCU");
          return Effect.succeed(
            registryOutput(key, JSON.stringify(hooks ? { hooks: { SessionStart: [] } } : {})),
          );
        },
      },
      (generation) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            operation === "resolveMemoryConflict"
              ? generation.resolveMemoryConflict!(memoryConflict)
              : generation.generateMemorySummary!(memorySummary),
          );
          expect(failure.cause).toMatchObject({ code: "unavailable" });
        }),
    ),
  );

  it.effect.each(
    memoryOperations.flatMap((operation) => ["win32", "wsl"].map((host) => ({ operation, host }))),
  )("$operation spawns with hook-free $host registry policy", ({ operation, host }) =>
    withFakeClaudeEnv(
      {
        platform: host === "win32" ? "win32" : "linux",
        wsl: host === "wsl",
        memoryRunnerContext: memoryContext,
        expectSpawn: true,
        output: JSON.stringify({
          structured_output:
            operation === "resolveMemoryConflict"
              ? { ...memoryOutput, judgment: "Synthetic" }
              : memoryOutput,
        }),
      },
      (generation) =>
        Effect.gen(function* () {
          const result =
            operation === "resolveMemoryConflict"
              ? yield* generation.resolveMemoryConflict!(memoryConflict)
              : yield* generation.generateMemorySummary!(memorySummary);
          expect(result.result.text).toBe(memoryOutput.text);
        }),
    ),
  );

  it.effect.each([
    { platform: "win32", environment: {} },
    { platform: "linux", environment: { WSL_DISTRO_NAME: "synthetic-wsl" } },
  ] as const)("checks registry policy precedence on $platform", ({ platform, environment }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const settings of [
        "{}",
        '{"wslInheritsWindowsSettings":true}',
        '{"model":"synthetic"}',
      ]) {
        const inspected: string[] = [];
        yield* verifyClaudeMemoryHooks("generateMemorySummary", environment).pipe(
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () => Effect.succeed(false),
          }),
          Effect.provideService(ClaudeMemoryRegistryQuery, (key, env) => {
            expect(env).toBe(environment);
            inspected.push(key);
            return Effect.succeed(
              registryOutput(key, key.startsWith("HKLM") ? settings : "{}", "REG_EXPAND_SZ"),
            );
          }),
        );
        expect(inspected).toEqual([
          "HKLM\\SOFTWARE\\Policies\\ClaudeCode",
          ...(settings.includes('"model"') ? [] : ["HKCU\\SOFTWARE\\Policies\\ClaudeCode"]),
        ]);
      }
    }),
  );

  it.effect.each(memoryOperations)("runs %s with tools hooks and MCP disabled", (operation) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output:
            operation === "resolveMemoryConflict"
              ? { ...memoryOutput, judgment: "Synthetic judgment" }
              : memoryOutput,
        }),
        memoryRunnerContext: memoryContext,
        cwdMustNotBe: memorySummary.cwd,
        argsMustContain:
          "--tools  --disable-slash-commands --strict-mcp-config --permission-mode dontAsk",
        stdinMustContain: "<untrusted_memory_data>",
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
            effectiveModel: `${SYNTHETIC_CLAUDE_STANDARD_MODEL}[expanded]`,
            effectiveProvider: "claudeAgent",
            providerInstanceId: memoryContext.providerInstanceId,
            environmentId: memoryContext.environmentId,
          });
        }),
    ),
  );
  it.effect.each(memoryOperations)("preserves frozen Claude options for %s", (operation) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output:
            operation === "resolveMemoryConflict"
              ? { ...memoryOutput, judgment: "Synthetic judgment" }
              : memoryOutput,
        }),
        memoryRunnerContext: memoryContext,
        argsMustContain: '--settings {"disableAllHooks":true,"alwaysThinkingEnabled":false}',
      },
      (generation) =>
        Effect.gen(function* () {
          const selection = M.MemoryModelSelection.make({
            ...memorySelection,
            model: SYNTHETIC_CLAUDE_THINKING_MODEL,
            options: [
              { id: "thinking", value: false },
              { id: "effort", value: "high" },
            ],
          });
          const generated =
            operation === "resolveMemoryConflict"
              ? yield* generation.resolveMemoryConflict!({
                  ...memoryConflict,
                  modelSelection: selection,
                })
              : yield* generation.generateMemorySummary!({
                  ...memorySummary,
                  modelSelection: selection,
                });
          expect(generated.execution.requestedModelSelection).toEqual(selection);
          expect(generated.execution.effectiveModel).toBe(SYNTHETIC_CLAUDE_THINKING_MODEL);
        }),
    ),
  );
  it.effect.each(
    memoryOperations.flatMap((operation) =>
      [
        "envelope denial",
        "result denial",
        "assistant tool",
        "user tool result",
        "permission event",
        "envelope tool",
      ].map((scenario) => ({ operation, scenario })),
    ),
  )("$operation discards $scenario even with valid final JSON", ({ operation, scenario }) => {
    const structured_output = {
      ...memoryOutput,
      ...(operation === "resolveMemoryConflict" ? { judgment: "Synthetic" } : {}),
    };
    const denial = {
      tool_name: "Bash",
      tool_use_id: "synthetic-tool",
      tool_input: { command: "synthetic" },
    };
    const final = { type: "result", structured_output };
    const output =
      scenario === "envelope denial"
        ? { structured_output, permission_denials: [denial] }
        : scenario === "result denial"
          ? [{ ...final, permission_denials: [denial] }, final]
          : scenario === "assistant tool"
            ? [
                {
                  type: "assistant",
                  message: {
                    content: [{ type: "tool_use", id: "synthetic-tool", name: "Bash", input: {} }],
                  },
                },
                final,
              ]
            : scenario === "user tool result"
              ? [
                  {
                    type: "user",
                    message: {
                      content: [
                        {
                          type: "tool_result",
                          tool_use_id: "synthetic-tool",
                          is_error: true,
                          content: "Permission denied",
                        },
                      ],
                    },
                  },
                  final,
                ]
              : scenario === "permission event"
                ? [{ type: "system", subtype: "permission_denied" }, final]
                : { structured_output, content: [{ type: "tool_use", name: "Read" }] };
    return withFakeClaudeEnv(
      {
        output: JSON.stringify(output),
        memoryRunnerContext: memoryContext,
        argsMustContain: "--verbose",
      },
      (generation) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            operation === "resolveMemoryConflict"
              ? generation.resolveMemoryConflict!(memoryConflict)
              : generation.generateMemorySummary!(memorySummary),
          );
          expect(failure.cause).toMatchObject({ code: "invalid_output" });
          expect(failure.detail).toContain("attempted a tool or permission request");
        }),
    );
  });
  it.effect.each(memoryOperations)(
    "%s accepts verbose output with empty diagnostics",
    (operation) =>
      withFakeClaudeEnv(
        {
          memoryRunnerContext: memoryContext,
          argsMustContain: "--verbose",
          output: JSON.stringify([
            { type: "system", subtype: "init" },
            { type: "assistant", message: { content: [{ type: "text", text: "Synthetic" }] } },
            {
              type: "result",
              permission_denials: [],
              structured_output: {
                ...memoryOutput,
                ...(operation === "resolveMemoryConflict" ? { judgment: "Synthetic" } : {}),
              },
            },
          ]),
        },
        (generation) =>
          Effect.gen(function* () {
            const result =
              operation === "resolveMemoryConflict"
                ? yield* generation.resolveMemoryConflict!(memoryConflict)
                : yield* generation.generateMemorySummary!(memorySummary);
            expect(result.result.text).toBe(memoryOutput.text);
          }),
      ),
  );

  it.effect.each(
    memoryOperations.flatMap((operation) =>
      [
        "round trip",
        "mixed executable tool",
        "mixed MCP tool",
        "unmatched result",
        "failed result",
        "permission denial",
      ].map((scenario) => ({ operation, scenario })),
    ),
  )("$operation handles StructuredOutput $scenario", ({ operation, scenario }) => {
    const structured_output = {
      ...memoryOutput,
      ...(operation === "resolveMemoryConflict" ? { judgment: "Synthetic" } : {}),
    };
    return withFakeClaudeEnv(
      {
        memoryRunnerContext: memoryContext,
        output: JSON.stringify([
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "StructuredOutput",
                  id: "structured",
                  input: structured_output,
                },
                ...(scenario.startsWith("mixed")
                  ? [
                      {
                        type: "tool_use",
                        name: scenario === "mixed MCP tool" ? "mcp__synthetic__run" : "Bash",
                        id: "executable",
                        input: {},
                      },
                    ]
                  : []),
              ],
            },
          },
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: scenario === "unmatched result" ? "other" : "structured",
                  is_error: scenario === "failed result",
                  content: "Structured output recorded",
                },
              ],
            },
          },
          {
            type: "result",
            structured_output,
            permission_denials:
              scenario === "permission denial" ? [{ tool_name: "StructuredOutput" }] : [],
          },
        ]),
      },
      (generation) =>
        Effect.gen(function* () {
          const run =
            operation === "resolveMemoryConflict"
              ? generation.resolveMemoryConflict!(memoryConflict)
              : generation.generateMemorySummary!(memorySummary);
          if (scenario === "round trip") {
            expect((yield* run).result.text).toBe(memoryOutput.text);
          } else {
            expect((yield* Effect.flip(run)).cause).toMatchObject({ code: "invalid_output" });
          }
        }),
    );
  });

  it.effect.each(memoryOperations)("rejects forged authority JSON for %s", (operation) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: { ...memoryOutput, judgment: "Forged", environmentId: "forged" },
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
    "rejects missing owner identity before Claude spawn for %s",
    (operation) =>
      withFakeClaudeEnv(
        { output: "{}", memoryRunnerContext: { providerInstanceId: memorySelection.instanceId } },
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

  it.effect(
    "keeps canonical built-in capabilities when a custom model collides with its alias",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Improve orchestration flow",
              body: "Body",
            },
          }),
          argsMustContain: `--model ${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded] --effort max --settings {"disableAllHooks":true,"fastMode":true}`,
          claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature/claude-effect",
              commitSummary: "Improve orchestration",
              diffSummary: "1 file changed",
              diffPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                ...createModelSelection(
                  ProviderInstanceId.make("claudeAgent"),
                  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
                  [
                    { id: "effort", value: "max" },
                    { id: "fastMode", value: true },
                  ],
                ),
              },
            });

            expect(generated.title).toBe("Improve orchestration flow");
          }),
      ),
  );

  it.effect(
    "generates thread titles outside the project with tools, skills, and hooks disabled",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title:
                '  "Reconnect failures after restart because the session state does not recover"  ',
            },
          }),
          cwdMustNotBe: process.cwd(),
          stdinMustContain: "/call-script",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "/call-script",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(
              sanitizeThreadTitle(
                '"Reconnect failures after restart because the session state does not recover"',
              ),
            );
          }),
      ),
  );

  it.effect("sends thread title instructions to the provider prompt", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Reconnect failures" } }),
        stdinMustContain: "Additional instructions:\nUse two to four words.",
      },
      (textGeneration) =>
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Investigate reconnect failures",
          instructions: "Use two to four words.",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
          },
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect.each([
    { verbose: false, label: "normal" },
    { verbose: true, label: "verbose" },
  ])("unwraps a JSON title in $label Claude output", ({ verbose }) => {
    const result = {
      type: "result",
      structured_output: { title: '{"title": "Refresh ev-stg APP ASG instances"}' },
    };
    return withFakeClaudeEnv(
      { output: JSON.stringify(verbose ? [result] : result) },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG instances");
        }),
    );
  });

  it.effect.each([
    { previousTitle: undefined, label: "generating" },
    { previousTitle: "Old thread title", label: "regenerating" },
  ])("reads the result from verbose Claude output when $label a title", ({ previousTitle }) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify([
          { type: "system", subtype: "init" },
          { type: "assistant", message: { content: [] } },
          { type: "user", message: { content: [] } },
          { type: "rate_limit_event" },
          {
            type: "result",
            subtype: "success",
            result: '{"title":"Refresh ev-stg APP ASG Instances"}',
            structured_output: { title: "Refresh ev-stg APP ASG Instances" },
          },
        ]),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            previousTitle,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG Instances");
        }),
    ),
  );

  it.effect.each([
    ["empty message array", []],
    ["missing result", [{ type: "assistant", structured_output: { title: "Not a result" } }]],
    ["invalid title", [{ type: "result", structured_output: { title: 42 } }]],
    [
      "final result without structured output",
      [
        { type: "result", structured_output: { title: "Earlier result" } },
        { type: "result", subtype: "error_max_structured_output_retries" },
      ],
    ],
  ] as const)("rejects verbose Claude output with %s", ([, output]) =>
    withFakeClaudeEnv({ output: JSON.stringify(output) }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error._tag).toBe("TextGenerationError");
      }),
    ),
  );

  const apiError = "API Error: 400 Model blocked by guardrail: 4 endpoints excluded";
  const wrapperNotice = "Using the OpenRouter credential from the global credential file.";
  it.effect.each([
    [
      "the stdout error over a stderr notice",
      JSON.stringify({ is_error: true, api_error_status: 400, result: apiError }),
      apiError,
    ],
    [
      "the verbose stdout error over a stderr notice",
      JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "result", is_error: true, result: apiError },
        { type: "result", is_error: true, result: " " },
      ]),
      apiError,
    ],
    ["stderr when stdout has no error", "not json", wrapperNotice],
  ] as const)("reports %s when the Claude CLI fails", ([, output, expected]) =>
    withFakeClaudeEnv({ output, stderr: wrapperNotice, exitCode: 1 }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error.detail).toBe(`Claude CLI command failed: ${expected}`);
      }),
    ),
  );
});

it.layer(layerClaudeTextGenerationTest)("channel reception", (it) => {
  it.effect("runs reception outside the project with tools disabled", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            replyText: "Which project?",
            action: "clarify",
            title: "",
            instruction: "",
            projectId: "",
            host: "",
            taskId: "",
            questionId: "",
            answer: "",
            question: "Which project?",
            options: [],
            reads: [],
            remember: "",
            rememberQuote: "",
            notesChangeRequested: "",
            clarifyAbout: "other",
          },
        }),
        cwdMustNotBe: process.cwd(),
        stdinMustContain: "Please re-verify the Opus 5.5 call",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateChannelReception;
          if (generate === undefined) return yield* Effect.die("reception missing");
          const result = yield* generate({
            cwd: process.cwd(),
            input: {
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
            },
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });
          expect(result).toEqual({
            replyText: "Which project?",
            action: { type: "clarify", question: "Which project?" },
          });
        }),
    ),
  );
});
