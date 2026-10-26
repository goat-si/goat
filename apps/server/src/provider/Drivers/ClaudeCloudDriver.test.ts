import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeCloudSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as PullRequests from "../../pullRequest/PullRequestService.ts";
import * as Projection from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@goat/shared/HostProcess";
import * as PtyAdapter from "@goat/shared/PtyAdapter";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { ClaudeCloudDriver } from "./ClaudeCloudDriver.ts";
import { BUNDLED_MODEL_MANIFEST } from "../ModelManifest.ts";
import { applyProviderCompatibility } from "../providerCompatibility.ts";

const INSTANCE = ProviderInstanceId.make("cloud-work");
const SIBLING = ProviderInstanceId.make("account-work");
const config = Schema.decodeSync(ClaudeCloudSettings)({ enabled: true, sourceInstanceId: SIBLING });
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [SIBLING]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      config: { binaryPath: "/fixture/claude-work", homePath: "~/claude-work" },
      environment: [{ name: "PROFILE_MARKER", value: "work-profile", sensitive: false }],
    },
  },
};

const harness = Effect.fnUntraced(function* (currentSettings = settings) {
  const commands: ChildProcess.StandardCommand[] = [];
  let ptySpawns = 0;
  const directories: string[] = [];
  const host = ProviderHost.ProviderHost.of({
    paths: {
      cwd: "/fixture/repo",
      baseDir: "/fixture/goat",
      stateDir: "/fixture/goat/userdata",
      providerStatusCacheDir: "/fixture/cache",
      attachmentsDir: "/fixture/attachments",
    },
    settings: {
      get: Effect.succeed(currentSettings),
      withSnapshot: (use) => use(currentSettings),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(true),
    resolveAttachmentPath: () => null,
    credentials: () => Effect.die("Claude Cloud must not read the GOAT credential store."),
  });
  const encoder = new TextEncoder();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline.");
      commands.push(command);
      const args = command.args;
      let stdout = "";
      if (args[0] === "--version") stdout = "2.1.296 (Claude Code)\n";
      else if (args[0] === "--help") stdout = "--cloud [description|session_id|url]\n";
      else if (args[0] === "auth") stdout = '{"loggedIn":true,"authMethod":"claude.ai"}\n';
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(90002),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const instance = yield* ClaudeCloudDriver.create({
    instanceId: INSTANCE,
    displayName: undefined,
    environment: [],
    enabled: true,
    config,
  }).pipe(
    Effect.provideService(ProviderHost.ProviderHost, host),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        makeDirectory: (cwd) =>
          Effect.sync(() => {
            directories.push(cwd);
          }),
      }),
    ),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(
      PtyAdapter.PtyAdapter,
      PtyAdapter.PtyAdapter.of({
        spawn: () => {
          ptySpawns += 1;
          return Effect.fail(new PtyAdapter.PtySpawnError({ adapter: "fixture" }));
        },
      }),
    ),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.HomeDirectory, "/fixture/home"),
    Effect.provideService(HostProcess.Environment, { HOME: "/fixture/home" }),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(PullRequests.PullRequestService)({}),
        Layer.mock(Projection.ProjectionStoreV2)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        SqlitePersistence.layerMemory,
      ),
    ),
  );
  return { instance, commands, directories, ptySpawns: () => ptySpawns };
});

it.effect(
  "readiness uses only the configured sibling path/env/config directory, preserving HOME",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const snapshot = yield* h.instance.snapshot.refresh;
        expect(snapshot.driver).toBe("claudeCloud");
        expect(snapshot.executionLocation).toBe("cloud");
        expect(snapshot.status).toBe("ready");
        expect(snapshot.message).toContain("Local changes may be included.");
        expect(snapshot.version).toBe("2.1.296");
        expect(
          applyProviderCompatibility(snapshot, [], BUNDLED_MODEL_MANIFEST.compatibility)
            .compatibilityAdvisory?.status,
        ).toBe("supported");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["cloud-default"]);
        const auth = h.commands.find((command) => command.args[0] === "auth")!;
        expect(auth.command).toBe("/fixture/claude-work");
        expect(auth.options.env?.HOME).toBe("/fixture/home");
        expect(auth.options.env?.CLAUDE_CONFIG_DIR).toBe("/fixture/home/claude-work");
        expect(auth.options.env?.PROFILE_MARKER).toBe("work-profile");
        expect(h.directories).toContain(`/fixture/cache/claude-cloud-control/${INSTANCE}`);
        expect(
          h.commands.every(
            (command) => command.options.cwd === `/fixture/cache/claude-cloud-control/${INSTANCE}`,
          ),
        ).toBe(true);
        expect(h.ptySpawns()).toBe(0);
      }),
    ),
);

it.effect.each([undefined, { driver: ProviderDriverKind.make("codex"), config: {} }])(
  "rejects a missing or foreign sibling",
  (entry) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({
          ...settings,
          providerInstances: entry ? { [SIBLING]: entry } : {},
        });
        const snapshot = yield* h.instance.snapshot.refresh;
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toMatch(/no longer exists|must use a Claude/);
        expect(h.commands).toEqual([]);
        expect(h.ptySpawns()).toBe(0);
      }),
    ),
);
