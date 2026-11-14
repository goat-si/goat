import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";

import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import type { PiSettings } from "../settings.ts";
import { OmoDriver, PiDriver } from "./driver.ts";

it("provides a separate OmO driver with its own binary and no home route settings", () => {
  assert.equal(OmoDriver.driverKind, "omo");
  assert.equal(OmoDriver.defaultConfig().binaryPath, "omo");
  assert.notProperty(OmoDriver.defaultConfig(), "modelRoute");
  assert.equal(OmoDriver.usage?.provider, "omo");
  assert.equal(PiDriver.defaultConfig().binaryPath, "pi");
});

const layerTest = Layer.mergeAll(
  TestProviderHost.layer({
    cwd: "/machine",
    settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
    runBackgroundWork: false,
  }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Unexpected HTTP")),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encoder = new TextEncoder();
const personalSkill = {
  name: "skill:personal",
  source: "skill",
  sourceInfo: { scope: "user", path: "/home/.pi/agent/skills/personal/SKILL.md" },
};

const makePiSpawner = Effect.fnUntraced(function* (
  discovery: { readonly state?: unknown; readonly models?: ReadonlyArray<unknown> } = {},
) {
  const pendingCommand = yield* Deferred.make<void>();
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = lazyChildProcessSpawner((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      launches.push(command);
      const version = command.args.includes("--version");
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const cwd = command.options.cwd;
      return ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so transport cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: version ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.succeed(!version),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const request = decodeRequest(new TextDecoder().decode(chunk).trim());
          if (cwd === "/pending" && request.type === "get_commands") {
            return Deferred.succeed(pendingCommand, undefined).pipe(Effect.asVoid);
          }
          const failed = cwd === "/failed" && request.type === "get_commands";
          const data =
            request.type === "get_commands"
              ? {
                  commands: [
                    personalSkill,
                    ...(cwd === "/machine"
                      ? []
                      : [
                          {
                            name: `skill:${cwd?.slice(1)}`,
                            source: "skill",
                            sourceInfo: {
                              scope: "project",
                              path: `${cwd}/.agents/skills/SKILL.md`,
                            },
                          },
                          { name: `prompt-${cwd?.slice(1)}`, source: "prompt" },
                        ]),
                  ],
                }
              : request.type === "get_available_models"
                ? { models: discovery.models ?? [{ provider: "test", id: "model" }] }
                : request.type === "get_state"
                  ? (discovery.state ?? {})
                  : {};
          return Queue.offer(
            stdout,
            encoder.encode(
              `${JSON.stringify({ type: "response", id: request.id, success: !failed, data, ...(failed ? { error: "commands unavailable" } : {}) })}\n`,
            ),
          ).pipe(Effect.asVoid);
        }),
        stdout: version ? Stream.succeed(encoder.encode("pi 1.0.2\n")) : Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, launches, pendingCommand };
});

const create = (config: Partial<PiSettings> = {}, enabled = true) =>
  PiDriver.create({
    instanceId: ProviderInstanceId.make("pi-workspace-test"),
    displayName: "My Pi",
    accentColor: "#abcdef",
    environment: [{ name: "PI_CODING_AGENT_DIR", value: "/isolated-pi", sensitive: false }],
    enabled,
    config: { ...PiDriver.defaultConfig(), binaryPath: "custom-pi", ...config },
  });

it.layer(layerTest)("PiDriver workspace discovery", (it) => {
  it.effect("maintenance resolves the executable once per uncached lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const executable = `${root}/custom-pi`;
      yield* fs.writeFileString(executable, "#!/bin/sh\n");
      yield* fs.chmod(executable, 0o755);
      let checks = 0;
      const countingFs: FileSystem.FileSystem = {
        ...fs,
        stat: (path) => {
          if (path === executable) checks++;
          return fs.stat(path);
        },
      };
      const instance = yield* create().pipe(
        Effect.provideService(HostProcess.Environment, { PATH: root, HOME: root }),
        Effect.provideService(FileSystem.FileSystem, countingFs),
      );
      assert.strictEqual(
        (yield* instance.snapshot.resolveMaintenance()).update?.executable,
        executable,
      );
      assert.strictEqual(checks, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("maintenance follows PATH changes and caches unchanged paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const oldDir = `${root}/old`;
      const newDir = `${root}/new`;
      for (const dir of [oldDir, newDir]) {
        yield* fs.makeDirectory(dir);
        yield* fs.writeFileString(`${dir}/custom-pi`, "#!/bin/sh\n");
        yield* fs.chmod(`${dir}/custom-pi`, 0o755);
      }
      const host = { PATH: oldDir, HOME: root };
      const instance = yield* create().pipe(Effect.provideService(HostProcess.Environment, host));
      const first = yield* instance.snapshot.resolveMaintenance();
      assert.strictEqual(first.update?.executable, `${oldDir}/custom-pi`);
      assert.strictEqual(
        (yield* instance.snapshot.resolveMaintenance()).update?.executable,
        first.update?.executable,
      );
      host.PATH = newDir;
      assert.strictEqual(
        (yield* instance.snapshot.resolveMaintenance()).update?.executable,
        `${newDir}/custom-pi`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("maintenance notices an executable installed into an unchanged PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const host = { PATH: root, HOME: root };
      const instance = yield* create().pipe(Effect.provideService(HostProcess.Environment, host));
      assert.isNull((yield* instance.snapshot.resolveMaintenance()).update);
      yield* fs.writeFileString(`${root}/custom-pi`, "#!/bin/sh\n");
      yield* fs.chmod(`${root}/custom-pi`, 0o755);
      assert.strictEqual(
        (yield* instance.snapshot.resolveMaintenance()).update?.executable,
        `${root}/custom-pi`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "regression #3079: Pi and OmO probes use the current host PATH and respect instance PATH",
    () =>
      Effect.gen(function* () {
        const host = { PATH: "/old/bin", HOME: "/fixture" };
        const { spawner, launches } = yield* makePiSpawner();
        for (const driver of [PiDriver, OmoDriver]) {
          const make = (override: boolean) =>
            driver
              .create({
                instanceId: ProviderInstanceId.make(`${driver.driverKind}-${override}`),
                displayName: undefined,
                enabled: true,
                environment: [
                  { name: "FIXTURE", value: "1", sensitive: false },
                  ...(override ? [{ name: "PATH", value: "/old/bin", sensitive: false }] : []),
                ],
                config: driver.defaultConfig(),
              })
              .pipe(
                Effect.provideService(HostProcess.Environment, host),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              );
          host.PATH = "/old/bin";
          const inherited = yield* make(false);
          const overridden = yield* make(true);
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/machine",
          });
          const sessionInput = {
            threadId: ThreadId.make(`${driver.driverKind}-thread`),
            providerSessionId: ProviderSessionId.make(`${driver.driverKind}-session`),
            modelSelection: { instanceId: inherited.instanceId, model: "default" },
            runtimePolicy,
          };
          yield* inherited.orchestrationAdapter.openSession(sessionInput);
          const oldLaunch = launches.at(-1);
          assert.equal(oldLaunch?.options.env?.PATH, "/old/bin");
          host.PATH = "/new/bin";
          yield* inherited.orchestrationAdapter.openSession({
            ...sessionInput,
            providerSessionId: ProviderSessionId.make(`${driver.driverKind}-new-session`),
          });
          assert.equal(launches.at(-1)?.options.env?.PATH, "/new/bin");
          assert.equal(oldLaunch?.options.env?.PATH, "/old/bin");
          const beforeInheritedRefresh = launches.length;
          yield* inherited.snapshot.refresh;
          assert.isAbove(launches.length, beforeInheritedRefresh);
          assert.equal(launches[beforeInheritedRefresh]?.options.env?.PATH, "/new/bin");
          yield* inherited.snapshotForCwd!("/first");
          assert.equal(
            launches.findLast((launch) => launch.options.cwd === "/first")?.options.env?.PATH,
            "/new/bin",
          );
          yield* overridden.orchestrationAdapter.openSession({
            ...sessionInput,
            providerSessionId: ProviderSessionId.make(`${driver.driverKind}-override-session`),
            modelSelection: { ...sessionInput.modelSelection, instanceId: overridden.instanceId },
          });
          assert.equal(launches.at(-1)?.options.env?.PATH, "/old/bin");
          const beforeOverriddenRefresh = launches.length;
          yield* overridden.snapshot.refresh;
          assert.isAbove(launches.length, beforeOverriddenRefresh);
          assert.equal(launches[beforeOverriddenRefresh]?.options.env?.PATH, "/old/bin");
        }
      }).pipe(Effect.scoped),
  );

  it.effect("keeps each workspace's skills and commands separate from the machine catalog", () =>
    Effect.gen(function* () {
      const { spawner, launches } = yield* makePiSpawner();
      const instance = yield* create({ launchArgs: '--approve --skill "extra skill"' }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      assert.isDefined(instance.snapshotForCwd);
      const [first, second] = yield* Effect.all(
        [instance.snapshotForCwd!("/first"), instance.snapshotForCwd!("/second")],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        first.skills.map((skill) => skill.name),
        ["personal", "first"],
      );
      assert.deepEqual(
        second.skills.map((skill) => skill.name),
        ["personal", "second"],
      );
      assert.deepEqual(
        first.slashCommands.map((command) => command.name),
        ["compact", "prompt-first"],
      );
      const machine = yield* instance.snapshot.getSnapshot;
      assert.deepEqual(
        machine.skills.map((skill) => skill.name),
        ["personal"],
      );
      assert.deepEqual(
        machine.slashCommands.map((command) => command.name),
        ["compact"],
      );
      assert.equal(first.instanceId, instance.instanceId);
      assert.equal(first.displayName, "My Pi");
      assert.equal(first.accentColor, "#abcdef");
      assert.deepEqual(first.models, machine.models);
      const workspaceLaunch = launches.find((launch) => launch.options.cwd === "/first");
      assert.isDefined(workspaceLaunch);
      assert.equal(workspaceLaunch!.command, "custom-pi");
      assert.includeMembers(
        [...workspaceLaunch!.args],
        ["--approve", "--skill", "extra skill", "--no-session"],
      );
      assert.equal(workspaceLaunch!.options.env?.PI_CODING_AGENT_DIR, "/isolated-pi");
      // Discovery processes are stopped as soon as they answer, so neither may start Pi's
      // network refresh at launch.
      for (const cwd of ["/machine", "/first"]) {
        const discovery = launches.find(
          (launch) => launch.options.cwd === cwd && launch.args.includes("--mode"),
        );
        assert.deepEqual(
          discovery?.args.filter((arg) => arg === "--offline"),
          ["--offline"],
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("does not run a disabled provider's workspace probe", () =>
    Effect.gen(function* () {
      const instance = yield* create({}, false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          lazyChildProcessSpawner(() => Effect.die("Disabled Pi must not spawn")),
        ),
      );
      assert.isDefined(instance.snapshotForCwd);
      const workspace = yield* instance.snapshotForCwd!("/first");
      assert.isFalse(workspace.enabled);
      assert.deepEqual(workspace.skills, []);
    }).pipe(Effect.scoped),
  );

  it.effect.each([true, false])(
    "limits discovered thinking defaults to the known active model, known=%s",
    (known) =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner({
          state: {
            thinkingLevel: "high",
            ...(known ? { model: { provider: "test", id: "model" } } : {}),
          },
          models: [
            { provider: "test", id: "model", reasoning: true },
            { provider: "other", id: "model", reasoning: true },
            { provider: "test", id: "other", reasoning: true },
          ],
        });
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        const snapshot = yield* instance.snapshot.getSnapshot;
        assert.deepEqual(
          snapshot.models.map((model) => [
            model.slug,
            (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor) =>
              descriptor.type === "select"
                ? descriptor.options.filter((option) => option.isDefault).map((option) => option.id)
                : [],
            ),
          ]),
          [
            ["default", []],
            ["test/model", known ? ["high"] : []],
            ["other/model", []],
            ["test/other", []],
          ],
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "fails command discovery instead of returning an empty successful workspace catalog",
    () =>
      Effect.gen(function* () {
        const { spawner } = yield* makePiSpawner();
        const instance = yield* create().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* instance.snapshot.refresh;
        assert.isDefined(instance.snapshotForCwd);
        const error = yield* Effect.flip(instance.snapshotForCwd!("/failed"));
        assert.equal(error._tag, "ProviderDriverError");
        assert.equal(error.instanceId, instance.instanceId);
        assert.deepEqual(
          (yield* instance.snapshot.getSnapshot).skills.map((skill) => skill.name),
          ["personal"],
        );
      }).pipe(Effect.scoped),
  );
});
