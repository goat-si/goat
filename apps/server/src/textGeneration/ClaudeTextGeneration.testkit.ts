import { processProbeSource } from "../testUtils/processProbe.ts";
import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";
import * as ServerConfig from "../config.ts";
import { SYNTHETIC_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.testFixtures.ts";
import type { ProviderTextGeneration } from "@goat/provider-core/server/textGeneration";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { ClaudeMemoryRegistryQuery } from "./ClaudeMemoryIsolation.ts";
import { writeFakeCli } from "@goat/provider-testing/fakeCli";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

export const layerClaudeTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
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

export const registryOutput = (key: string, settings: string, type = "REG_SZ") =>
  `\n${key.replace("HKLM", "HKEY_LOCAL_MACHINE").replace("HKCU", "HKEY_CURRENT_USER")}\n    Settings    ${type}    ${settings}\n`;
export const emptyRegistryQuery = (key: string) => Effect.succeed(registryOutput(key, "{}"));

const decodeFixtureArgv = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

export function withFakeClaudeEnv<A, E, R>(
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
    rejectsNoSessionPersistence?: boolean;
    rejectPersistenceAlways?: boolean;
    expectSpawnCount?: number;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    expectedTools?: string;
    settingsMustContain?: string;
    expectPrivateSettings?: boolean;
    settingsTempRoot?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    cwdMustNotBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: ProviderTextGeneration) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const pathDelimiter = (yield* HostProcess.isWindows) ? ";" : ":";
    const updates = {
      PATH: `${binDir}${pathDelimiter}${process.env.PATH ?? ""}`,
      GOAT_FAKE_CLAUDE_REJECTS_NO_SESSION_PERSISTENCE: input.rejectsNoSessionPersistence
        ? "1"
        : undefined,
      GOAT_FAKE_CLAUDE_REJECT_PERSISTENCE_ALWAYS: input.rejectPersistenceAlways ? "1" : undefined,
      GOAT_FAKE_CLAUDE_ATTEMPTS:
        input.expectSpawnCount === undefined ? undefined : `${tempDir}/attempts`,
      GOAT_FAKE_CLAUDE_OUTPUT: input.output,
      GOAT_FAKE_CLAUDE_EXIT_CODE: input.exitCode === undefined ? undefined : String(input.exitCode),
      GOAT_FAKE_CLAUDE_STDERR: input.stderr,
      GOAT_FAKE_CLAUDE_SETTINGS_MUST_CONTAIN: input.settingsMustContain,
      GOAT_FAKE_CLAUDE_CHECK_SETTINGS_MODE:
        input.expectPrivateSettings && pathDelimiter !== ";" ? "1" : undefined,
      GOAT_FAKE_CLAUDE_ARGS_MUST_CONTAIN: input.argsMustContain,
      GOAT_FAKE_CLAUDE_EXPECTED_TOOLS: input.expectedTools,
      GOAT_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN: input.argsMustNotContain,
      GOAT_FAKE_CLAUDE_STDIN_MUST_CONTAIN: input.stdinMustContain,
      GOAT_FAKE_CLAUDE_CWD_MUST_NOT_BE: input.cwdMustNotBe,
      GOAT_FAKE_CLAUDE_CONFIG_DIR_MUST_BE: input.configDirMustBe,
    };
    const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
    const apply = (values: Readonly<Record<string, string | undefined>>) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => apply(updates)),
      () => Effect.sync(() => apply(previous)),
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
        makeTempDirectoryScoped: (options) =>
          input.settingsTempRoot !== undefined &&
          options?.prefix?.startsWith("goat-claude-settings-")
            ? fs.makeTempDirectoryScoped({ ...options, directory: input.settingsTempRoot })
            : fs.makeTempDirectoryScoped(options),
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
    if (input.expectSpawnCount === 0) {
      expect(yield* fs.exists(`${tempDir}/attempts`)).toBe(false);
    } else if (input.expectSpawnCount !== undefined) {
      const attempts = yield* fs.readFileString(`${tempDir}/attempts`);
      const lines = attempts.trim().split("\n");
      expect(lines).toHaveLength(input.expectSpawnCount);
      if (input.expectPrivateSettings) {
        for (const line of lines) {
          const argv = decodeFixtureArgv(line);
          const settingsPath = argv[argv.indexOf("--settings") + 1];
          expect(settingsPath).toBeDefined();
          if (settingsPath !== undefined) expect(yield* fs.exists(settingsPath)).toBe(false);
        }
      }
    }
    if (input.expectNoSpawn) expect(yield* fs.exists(`${tempDir}/spawned`)).toBe(false);
    if (input.expectSpawn) expect(yield* fs.exists(`${tempDir}/spawned`)).toBe(true);
    return result;
  }).pipe(
    Effect.provideService(ClaudeMemoryRegistryQuery, input.registryQuery ?? emptyRegistryQuery),
    Effect.scoped,
  );
}
