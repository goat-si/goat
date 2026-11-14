import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  type ProviderInstanceEnvironment,
  ProviderSessionId,
  RunAttemptId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as HostProcess from "@goat/shared/HostProcess";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { ClaudeExecutableFileCheck } from "../../provider/Drivers/ClaudeExecutable.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
} from "./ClaudeTestInput.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

const captureSdkExecutablePaths = Effect.fn("captureSdkExecutablePaths")(function* (
  binaryPath: string,
  environment: ProviderInstanceEnvironment = [],
  hostEnvironment?: NodeJS.ProcessEnv,
  providedHome?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const home =
    providedHome ?? (yield* fs.makeTempDirectoryScoped({ prefix: "claude-launch-home-" }));
  const host = hostEnvironment ?? { PATH: "/usr/bin:/bin", HOME: home };
  host.HOME = home;
  host.CLAUDE_CONFIG_DIR = home;
  const guarded = {
    ...fs,
    readFileString: (file: string) =>
      fs.readFileString(
        (file.endsWith("settings.json") || file.endsWith("settings.local.json")) &&
          !file.startsWith(home + "/") &&
          !file.startsWith(home + "\\")
          ? home + "/missing-managed-settings"
          : file,
      ),
  };
  const environments: Array<NodeJS.ProcessEnv | undefined> = [];
  const executablePaths: Array<string | undefined> = [];
  const taskToolEnvironment: Array<string | undefined> = [];
  const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
    {
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      displayName: undefined,
      environment,
      enabled: true,
      config: { ...DEFAULT_CLAUDE_SETTINGS, binaryPath },
    },
    {},
  ).pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, host),
    Effect.provideService(FileSystem.FileSystem, guarded),
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "goat-claude-binary-path-",
      }),
    ),
    Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      allocateSessionId: Effect.succeed("native-thread-claude-binary-path"),
      open: (input) =>
        Effect.sync(() => {
          environments.push(input.options.env);
          executablePaths.push(input.options.pathToClaudeCodeExecutable);
          taskToolEnvironment.push(input.options.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS);
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
    }),
  );
  if (hostEnvironment) hostEnvironment.PATH = "/new/bin";
  const threadId = ThreadId.make("thread-claude-binary-path");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-claude-binary-path"),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  yield* runtime.startTurn(
    makeClaudeTestTurnInput({
      threadId,
      providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("attempt-claude-binary-path"),
      text: "hello",
      attachments: [],
    }),
  );
  return { executablePaths, taskToolEnvironment, environments };
});

describe("ClaudeAdapterV2 executable path", () => {
  it.effect("never reads host Claude settings during launch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "claude-launch-test-" });
      const host = { PATH: "/usr/bin:/bin" };
      const outside: string[] = [];
      const guarded = {
        ...fs,
        readFileString: (file: string) => {
          if (
            file.endsWith("settings.json") &&
            !file.startsWith(home + "/") &&
            !file.startsWith(home + "\\")
          ) {
            outside.push(file);
            return fs.readFileString(home + "/missing");
          }
          return fs.readFileString(file);
        },
      };
      yield* captureSdkExecutablePaths("claude", [], host, home).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(FileSystem.FileSystem, guarded),
      );
      assert.equal(outside.length, 0);
    }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
  );
  it.effect(
    "regression #3079: a new query uses the host PATH current at its start, and an instance PATH still wins",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const host = { PATH: "/usr/bin:/bin" };
          const { environments } = yield* captureSdkExecutablePaths("claude", [], host).pipe(
            Effect.provideService(HostProcess.Environment, host),
          );
          assert.equal(environments[0]?.PATH, "/new/bin");
          assert.equal(Object.getPrototypeOf(environments[0]), Object.prototype);
          const pinnedHost = { PATH: "/usr/bin:/bin" };
          const pinned = yield* captureSdkExecutablePaths(
            "claude",
            [{ name: "PATH", value: "/usr/bin:/bin", sensitive: false }],
            pinnedHost,
          ).pipe(Effect.provideService(HostProcess.Environment, pinnedHost));
          assert.equal(pinned.environments[0]?.PATH, "/usr/bin:/bin");
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("follows a bare claude on Windows to the npm package executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const npmDir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
        const packageExe = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
        const { executablePaths } = yield* captureSdkExecutablePaths("claude").pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, () => `${npmDir}\\claude.cmd`),
          Effect.provideService(ClaudeExecutableFileCheck, (filePath) => filePath === packageExe),
        );

        assert.deepEqual(executablePaths, [packageExe]);
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );
});
