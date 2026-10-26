// @effect-diagnostics nodeBuiltinImport:off - Tests exercise native Node fixture boundaries.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeHttp from "node:http";
import { vi } from "vite-plus/test";
import { updateCommand } from "../cli/update.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import {
  parseServiceState,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";
// A real listener: `goat update` builds its own FetchHttpClient, so the mock client never sees the probe.

const linuxRuntime = "/home/theo/.t3/runtime/goat/versions/1.2.3/goat";
const linuxPlan = {
  program: [linuxRuntime, "__service-launcher"],
  baseDir: "/home/theo/.t3",
  logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
  unitPath: "/home/theo/.config/systemd/user/goat.service",
};

it("reads the served T3 home back out of a rendered unit or plist", () => {
  const plan = (baseDir: string) => ({
    program: [`${baseDir}/runtime/goat/versions/1.2.3/goat`, "__service-launcher"],
    baseDir,
    logPath: `${baseDir}/userdata/logs/boot-service.log`,
    unitPath: "/home/theo/.config/systemd/user/goat.service",
  });

  expect(
    BootService.bootServiceBaseDirOf(BootService.renderBootServiceUnit(plan("/home/theo/.t3"))),
  ).toBe("/home/theo/.t3");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServiceUnit(plan("/home/theo/T3 Data/100%")),
    ),
  ).toBe("/home/theo/T3 Data/100%");
  expect(
    BootService.bootServiceBaseDirOf(
      BootService.renderBootServicePlist(plan("/Users/theo/a&b"), {
        homeDir: "/Users/theo",
        environmentPath: "/usr/bin",
      }),
    ),
  ).toBe("/Users/theo/a&b");
  expect(BootService.bootServiceBaseDirOf("[Service]\nExecStart=/x\n")).toBeUndefined();
});

it("reads the home of units installed before the GOAT rename", () => {
  // goat-rename: legacy-begin
  expect(
    BootService.bootServiceBaseDirOf("[Service]\nEnvironment=T3CODE_HOME=/home/theo/.t3\n"),
  ).toBe("/home/theo/.t3");
  expect(
    BootService.bootServiceBaseDirOf(
      "<dict>\n    <key>T3CODE_HOME</key>\n    <string>/Users/theo/.t3</string>\n</dict>",
    ),
  ).toBe("/Users/theo/.t3");
  // goat-rename: legacy-end
  const unit = BootService.renderBootServiceUnit(linuxPlan);
  expect(BootService.bootServiceBaseDirOf(unit)).toBe(linuxPlan.baseDir);
  expect(unit).toContain(`Environment=GOAT_HOME=${linuxPlan.baseDir}`);
  expect(unit).toContain(`Environment=T3CODE_HOME=${linuxPlan.baseDir}`); // goat-rename: legacy
});

it.each([
  ["a unit", '/home/theo/T3 "Data"/100%\\x', BootService.renderBootServiceUnit],
  [
    "a plist",
    "/Users/theo/a&b <c>",
    (plan: BootService.BootServicePlan) =>
      BootService.renderBootServicePlist(plan, { homeDir: "/Users/theo", environmentPath: "" }),
  ],
] as const)("reads the launcher back out of %s", (_, baseDir, render) => {
  const program = `${baseDir}/runtime/versions/1.2.3/t3`;
  expect(
    BootService.bootServiceProgramOf(
      render({ program: [program, "__service-launcher"], baseDir, logPath: "/log", unitPath: "" }),
    ),
  ).toBe(program);
});

const macRuntime = "/Users/theo/.t3/runtime/goat/versions/1.2.3/goat";
const macPlan = {
  program: [macRuntime, "__service-launcher"],
  baseDir: "/Users/theo/.t3",
  logPath: "/Users/theo/.t3/userdata/logs/boot-service.log",
  unitPath: "/Users/theo/Library/LaunchAgents/si.goat.service.plist",
};
const macInstallerPath =
  "/opt/homebrew/bin:/Users/theo/.npm-global/bin:/Users/theo/.nvm/versions/node/v22.16.0/bin:/usr/bin:/bin";
const macRenderOptions = { homeDir: "/Users/theo", environmentPath: macInstallerPath };

const makeHarness = Effect.fn("test.make_boot_service_harness")(function* (
  platform: NodeJS.Platform = "linux",
  installerPath = macInstallerPath,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-boot-service-test-" });
  const baseDir = path.join(home, ".t3");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3", platform);
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "#!/bin/sh\n");
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");

  const commands: string[] = [];
  const invocations: ProcessRunner.ProcessRunInput[] = [];
  const timeouts = new Map<string, unknown>();
  const control: {
    failCommand: string | undefined;
    stateAfterStop?: string;
    linger: string;
    enabled: boolean;
    active: boolean;
    /** When false, a start command returns success but the server never answers. */
    answers: boolean;
    answeredVersion: string | undefined;
  } = {
    failCommand: undefined,
    linger: "yes",
    enabled: true,
    active: true,
    answers: true,
    answeredVersion: undefined,
  };
  const readinessServer = NodeHttp.createServer((request, response) => {
    if (
      request.url?.startsWith("/.well-known/goat/environment") &&
      control.answeredVersion !== undefined
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ serverVersion: control.answeredVersion }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      readinessServer.once("error", (error) => {
        resume(Effect.die(error));
      });
      readinessServer.listen(0, "127.0.0.1", () => {
        resume(Effect.void);
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        readinessServer.close(() => {
          resume(Effect.void);
        });
      }),
  );
  const readinessAddress = readinessServer.address();
  const readinessPort =
    typeof readinessAddress === "object" && readinessAddress !== null ? readinessAddress.port : 0;
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("test.run_boot_service_command")(function* (
      input: ProcessRunner.ProcessRunInput,
    ) {
      const command = `${input.command} ${input.args.join(" ")}`;
      commands.push(command);
      invocations.push(input);
      timeouts.set(command, input.timeout);
      const failed = command === control.failCommand;
      if (!failed && command === "loginctl enable-linger --no-ask-password 501")
        control.linger = "yes";
      if (!failed && command === "systemctl --user enable goat.service") control.enabled = true;
      const publishAnswer = (unitFile: string) =>
        Effect.gen(function* () {
          if (!control.answers) {
            control.active = false;
            return;
          }
          const contents = yield* fs.readFileString(unitFile).pipe(Effect.option);
          if (Option.isNone(contents)) return;
          const served = BootService.bootServiceBaseDirOf(contents.value);
          const version = /versions\/([^/]+)\/goat/.exec(contents.value)?.[1];
          if (served === undefined || version === undefined) return;
          control.answeredVersion = version;
          control.active = true;
          const runtimePath = path.join(served, "userdata", "server-runtime.json");
          const startedAt = DateTime.formatIso(yield* DateTime.now);
          yield* fs.makeDirectory(path.dirname(runtimePath), { recursive: true });
          yield* fs.writeFileString(
            runtimePath,
            JSON.stringify({
              version: 1,
              pid: 4242,
              port: readinessPort,
              origin: `http://127.0.0.1:${readinessPort}`,
              startedAt,
              serviceManaged: true,
              serverVersion: version,
            }),
          );
        }).pipe(Effect.orDie);
      if (!failed && command === "systemctl --user restart goat.service") {
        yield* publishAnswer(path.join(home, ".config", "systemd", "user", "goat.service"));
      }
      if (!failed && command.startsWith("launchctl bootstrap ")) {
        const plist = input.args.at(-1);
        if (plist !== undefined) yield* publishAnswer(plist);
      }
      // A stop that fails (a timeout, say) has still stopped the service.
      if (command === "systemctl --user stop goat.service") control.active = false;
      if (
        control.stateAfterStop !== undefined &&
        (command === "systemctl --user stop goat.service" ||
          command.startsWith("launchctl bootout --wait "))
      ) {
        yield* fs.writeFileString(statePath, control.stateAfterStop).pipe(Effect.orDie);
      }
      return {
        stdout:
          input.args[0] === "--version"
            ? `t3 v${/versions\/([^/]+)\//.exec(input.command)?.[1] ?? "1.2.3"}\n`
            : input.command === "loginctl" && input.args[0] === "show-user"
              ? `${control.linger}\n`
              : input.args[1] === "is-enabled"
                ? control.enabled
                  ? "enabled\n"
                  : "disabled\n"
                : "",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(
          failed ||
            (input.args[1] === "is-active" && !control.active) ||
            (input.args[1] === "is-enabled" && !control.enabled)
            ? 1
            : 0,
        ),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    }),
  });
  const makeService = (
    environmentPath: string | undefined = installerPath,
    cliVersion = "1.2.3",
    serviceBaseDir = baseDir,
    insideService = false,
  ) =>
    Effect.gen(function* () {
      const paths = pinnedRuntimePaths(path, serviceBaseDir, cliVersion, platform);
      yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "#!/bin/sh\n");
      yield* fs.writeFileString(paths.sentinelPath, `${cliVersion}\n`);
      return yield* BootService.make({
        baseDir: serviceBaseDir,
        logsDir: path.join(serviceBaseDir, "userdata", "logs"),
        cliVersion,
        host: { execPath: "/usr/bin/goat" },
      });
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, platform),
          Layer.succeed(HostProcess.UserId, 501),
          Layer.succeed(HostProcess.ExecutablePath, "/usr/bin/goat"),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.suspend(() => {
                const url = String(request.url);
                return url.includes("/.well-known/goat/environment") &&
                  control.answeredVersion !== undefined
                  ? Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        Response.json({ serverVersion: control.answeredVersion }),
                      ),
                    )
                  : Effect.die(`no release download expected: ${url}`);
              }),
            ),
          ),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                HOME: home,
                ...(environmentPath === undefined || environmentPath === ""
                  ? {}
                  : { PATH: environmentPath }),
                ...(insideService ? { GOAT_BOOT_SERVICE_UNIT: "goat.service" } : {}),
              },
            }),
          ),
        ),
      ),
    );
  const service = yield* makeService();
  return {
    service,
    makeService,
    fs,
    home,
    baseDir,
    statePath,
    commands,
    invocations,
    timeouts,
    control,
    runtime,
    runner,
  };
});

it.layer(NodeServices.layer)("boot service install", (it) => {
  it.effect(
    "fails before installing files or validating a runtime when lingering needs an administrator",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control, runtime } = yield* makeHarness();
        const before = yield* service.status;
        control.linger = "no";
        control.failCommand = "loginctl enable-linger --no-ask-password 501";
        yield* fs.remove(runtime.sentinelPath);

        const error = yield* service.install().pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "BootServicePrerequisiteError",
          problem: "linger-disabled",
        });
        expect(error.message).toContain('sudo loginctl enable-linger "$(id -un)"');
        expect(error.message).toContain("last login session ends");
        expect(yield* fs.exists(before.unitPath)).toBe(false);
        expect(yield* fs.exists(statePath)).toBe(false);
        expect(commands.some((command) => command.includes("--version"))).toBe(false);
        expect(
          commands.some(
            (command) => command.includes("daemon-reload") || command.includes("restart"),
          ),
        ).toBe(false);
        expect(yield* fs.readFileString(before.logPath)).toContain("[linger-disabled]");
      }),
  );

  it.effect(
    "detects a partial install and preserves the running service when repair lacks permission",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control } = yield* makeHarness();
        const plan = yield* service.install();
        const before = yield* fs.readFileString(statePath);
        const unit = yield* fs.readFileString(plan.unitPath);
        control.linger = "no";
        control.failCommand = "loginctl enable-linger --no-ask-password 501";

        expect(yield* service.status).toMatchObject({
          current: false,
          problems: ["linger-disabled"],
        });
        commands.length = 0;
        expect((yield* service.install().pipe(Effect.flip))._tag).toBe(
          "BootServicePrerequisiteError",
        );
        expect(yield* fs.readFileString(statePath)).toBe(before);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(commands).not.toContain("systemctl --user stop goat.service");
      }),
  );

  it.effect("enables lingering before installing and repairs stopped or disabled services", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      control.linger = "no";
      yield* service.install();
      expect(control.linger).toBe("yes");
      expect(commands.indexOf("loginctl enable-linger --no-ask-password 501")).toBeLessThan(
        commands.indexOf("systemctl --user daemon-reload"),
      );

      control.enabled = false;
      control.active = false;
      expect(yield* service.status).toMatchObject({
        current: false,
        problems: ["service-disabled", "service-stopped"],
      });
      yield* service.install();
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect.each([
    { command: "systemctl --user show-environment", problem: "user-manager-unavailable" },
    { command: "loginctl show-user 501 --property=Linger --value", problem: "linger-unavailable" },
  ])("reports failed prerequisite probes without installing: $command", ({ command, problem }) =>
    Effect.gen(function* () {
      const { service, fs, statePath, control } = yield* makeHarness();
      control.failCommand = command;
      expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem,
      });
      expect(yield* fs.exists(statePath)).toBe(false);
    }),
  );

  it.effect("installs, reports current state, and uninstalls", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, timeouts, runtime } = yield* makeHarness();
      const plan = yield* service.install();

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(plan.program).toEqual([runtime.entryPath, "__service-launcher"]);
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `ExecStart=${runtime.entryPath} __service-launcher`,
      );
      expect(yield* service.status).toMatchObject({
        current: true,
        installedVersion: "1.2.3",
      });
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "u",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/tmp/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      expect((yield* service.status).current).toBe(false);
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      // The stop can block up to systemd's 90s TimeoutStopSec; the runner's
      // 60s default would cancel it mid-shutdown.
      expect(timeouts.get("systemctl --user disable --now goat.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "reports the installed version across launcher protocols on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath } = yield* makeHarness(platform);
        yield* service.install();

        for (const protocol of [SERVICE_LAUNCHER_PROTOCOL - 1, SERVICE_LAUNCHER_PROTOCOL + 1]) {
          yield* fs.writeFileString(
            statePath,
            `{"protocol":${protocol},"activeVersion":"1.2.4-nightly.1","update":{"status":"unknown"}}`,
          );
          expect(yield* service.status).toMatchObject({
            current: false,
            installedVersion: "1.2.4-nightly.1",
          });
        }
      }),
  );

  // regression: #5302 prevent accidental service downgrades
  it.effect("reports an unknown version for invalid service state", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();

      for (const stateText of [
        "{",
        '{"activeVersion":"latest"}',
        '{"activeVersion":"1.2"}',
        '{"activeVersion":123}',
      ]) {
        yield* fs.writeFileString(statePath, stateText);
        const status = yield* service.status;
        expect(status.current).toBe(false);
        expect(status.installedVersion).toBeUndefined();
      }
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "preserves a newer version that finishes updating during stop on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control } = yield* makeHarness(platform);
        const plan = yield* service.install();
        const unit = yield* fs.readFileString(plan.unitPath);
        control.stateAfterStop = `{"protocol":${SERVICE_LAUNCHER_PROTOCOL + 1},"activeVersion":"1.2.4"}`;
        commands.length = 0;

        const error = yield* service.install().pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "1.2.4",
          targetVersion: "1.2.3",
        });
        expect(yield* fs.readFileString(statePath)).toBe(control.stateAfterStop);
        expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
        expect(
          commands.filter(
            (command) =>
              command.startsWith(platform === "linux" ? "systemctl " : "launchctl ") &&
              !command.includes("show-environment"),
          ),
        ).toEqual(
          platform === "linux"
            ? ["systemctl --user stop goat.service", "systemctl --user restart goat.service"]
            : [
                "launchctl bootout --wait gui/501/si.goat.service",
                `launchctl bootstrap gui/501 ${plan.unitPath}`,
                "launchctl kickstart gui/501/si.goat.service",
              ],
        );
      }),
  );

  // regression: #5302 prevent accidental service downgrades
  it.effect("allows an explicit downgrade", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.4"}`,
      );

      yield* service.install({ allowDowngrade: true });

      expect(parseServiceState(yield* fs.readFileString(statePath))?.activeVersion).toBe("1.2.3");
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("repairs versions with equal SemVer precedence without an override", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* fs.writeFileString(
        statePath,
        `{"protocol":${SERVICE_LAUNCHER_PROTOCOL},"activeVersion":"1.2.3+previous-build"}`,
      );

      yield* service.install();

      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "install with start=false rewrites files, preserves service.env, and marks a restart pending on %s",
    (platform) =>
      Effect.gen(function* () {
        const { service, fs, baseDir, statePath, commands, makeService } =
          yield* makeHarness(platform);
        const path = yield* Path.Path;
        const envPath = path.join(baseDir, SERVICE_ENV_FILE);
        const envBytes = new TextEncoder().encode(
          '# user configuration\r\nGOAT_TOKEN="literal $HOME # token"',
        );
        yield* fs.writeFile(envPath, envBytes);
        yield* service.install();
        expect(new Uint8Array(yield* fs.readFile(envPath))).toEqual(envBytes);
        yield* service.install();
        expect(new Uint8Array(yield* fs.readFile(envPath))).toEqual(envBytes);
        commands.length = 0;

        const newer = yield* makeService(undefined, "1.2.4");
        const plan = yield* newer.install({ start: false });
        expect(new Uint8Array(yield* fs.readFile(envPath))).toEqual(envBytes);

        expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.4",
        });
        expect(yield* fs.readFileString(plan.unitPath)).toContain("versions/1.2.4/goat");
        expect(
          commands.filter(
            (command) =>
              /^(systemctl|launchctl) /.test(command) && !command.includes("show-environment"),
          ),
        ).toEqual([]);
        const status = yield* newer.status;
        expect(status.current).toBe(false);
        expect(status.problems).toContain("restart-pending");

        commands.length = 0;
        expect(yield* newer.restart).toBe("restarted");
        expect((yield* newer.status).problems).not.toContain("restart-pending");
        expect((yield* newer.status).current).toBe(true);
      }),
  );

  it.effect("install with start=false keeps the marker when a later write fails", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, makeService } = yield* makeHarness();
      const path = yield* Path.Path;
      yield* service.install();
      const newer = yield* makeService(undefined, "1.2.4");
      const unitPath = (yield* service.status).unitPath;
      yield* fs.remove(unitPath);
      yield* fs.makeDirectory(unitPath);
      yield* fs.writeFileString(path.join(unitPath, "occupied"), "");

      const error = yield* newer.install({ start: false }).pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceInstallError");
      expect(
        yield* fs.exists(path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE)),
      ).toBe(true);
    }),
  );

  it.effect("install with start=false refuses while a remote update is pending", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
        update: {
          id: "u",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          dbPath: "/tmp/state.sqlite",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);

      const error = yield* service.install({ start: false }).pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceUpdatePendingError");
      expect(yield* fs.readFileString(statePath)).toBe(pendingState);
    }),
  );

  it.effect("pauses only this home's running service for maintenance, even when it fails", () =>
    Effect.gen(function* () {
      const { service, commands, control, makeService } = yield* makeHarness();
      yield* service.install();
      const failure = yield* service
        .withStopped(
          Effect.suspend(() => Effect.fail(control.active ? "running" : "repair failed")),
        )
        .pipe(Effect.flip);
      expect(failure).toBe("repair failed");
      expect(control.active).toBe(true);

      // A failed stop skips the operation but still starts the service again.
      control.failCommand = "systemctl --user stop goat.service";
      let ran = false;
      const stopFailure = yield* service
        .withStopped(
          Effect.sync(() => {
            ran = true;
          }),
        )
        .pipe(Effect.flip);
      expect(stopFailure).toMatchObject({
        _tag: "BootServiceCommandError",
        step: "stopping the installed service",
      });
      expect(ran).toBe(false);
      expect(control.active).toBe(true);
      control.failCommand = undefined;

      control.active = false;
      commands.length = 0;
      yield* service.withStopped(Effect.sync(() => commands.push("repair")));
      expect(commands).toEqual([
        "systemctl --user is-enabled goat.service",
        "systemctl --user is-active goat.service",
        "systemctl --user stop goat.service",
        "repair",
        "systemctl --user restart goat.service",
      ]);
      expect(control.active).toBe(true);
      control.enabled = false;
      yield* service.withStopped(Effect.void);
      expect(control).toMatchObject({ active: true, enabled: false });
      control.active = false;
      control.enabled = false;
      commands.length = 0;
      yield* service.withStopped(Effect.sync(() => commands.push("repair")));
      expect(commands).toContain("systemctl --user stop goat.service");
      expect(commands).not.toContain("systemctl --user restart goat.service");
      expect(control.active).toBe(false);
      control.enabled = true;
      control.active = true;

      const fs = yield* FileSystem.FileSystem;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "goat-doctor-other-" });
      const other = yield* makeService(undefined, "1.2.3", otherHome);
      commands.length = 0;
      expect(yield* other.withStopped(Effect.sync(() => control.active))).toBe(true);
      expect(commands).toEqual([]);
    }),
  );

  it.effect("restart leaves a service that serves another T3 home alone", () =>
    Effect.gen(function* () {
      const { service, fs, commands, makeService } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      const path = yield* Path.Path;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "goat-other-home-" });

      const other = yield* makeService(undefined, "1.2.3", path.join(otherHome, ".t3"));
      expect(yield* other.restart).toBe("skipped");
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([]);
    }),
  );

  it.effect("hands the whole install to systemd without changing the running service", () =>
    Effect.gen(function* () {
      const { fs, commands, invocations, control, makeService } = yield* makeHarness();
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-handoff-" });
      const baseDir = path.join(home, "T3 Data 100%", "${UNSET}", "$literal");
      const outside = yield* makeService(undefined, "1.2.3", baseDir);
      const plan = yield* outside.install();
      const statePath = path.join(baseDir, "runtime", "service-state.json");
      const state = yield* fs.readFileString(statePath);
      const unit = yield* fs.readFileString(plan.unitPath);
      const inside = yield* makeService(undefined, "1.2.4", baseDir, true);
      commands.length = 0;
      invocations.length = 0;

      const result = yield* inside.install({ allowDowngrade: true });

      expect(yield* fs.readFileString(statePath)).toBe(state);
      expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
      expect(commands).not.toContain("systemctl --user stop goat.service");
      expect(result).toMatchObject({ handedOff: true, logPath: plan.logPath });
      const handoffs = invocations.filter(({ command }) => command === "systemd-run");
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]?.args).toEqual([
        "--user",
        "--collect",
        "--quiet",
        `--property=StandardOutput=append:${plan.logPath}`,
        `--property=StandardError=append:${plan.logPath}`,
        "--setenv=GOAT_BOOT_SERVICE_UNIT=",
        pinnedRuntimePaths(path, baseDir, "1.2.4", "linux").entryPath,
        "service",
        "install",
        "--base-dir",
        path.join(home, "T3 Data 100%", "$${UNSET}", "$$literal"),
        "--allow-downgrade",
      ]);

      const handoff = handoffs[0]!;
      control.failCommand = `${handoff.command} ${handoff.args.join(" ")}`;
      const error = yield* inside.install({ allowDowngrade: true }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "BootServiceCommandError", exitCode: 1 });
      expect(yield* fs.readFileString(statePath)).toBe(state);
      expect(yield* fs.readFileString(plan.unitPath)).toBe(unit);
      expect(control.active).toBe(true);
      expect(commands).not.toContain("systemctl --user stop goat.service");
    }),
  );

  it.effect(
    "queues an in-service restart without stopping the caller, even on handoff failure",
    () =>
      Effect.gen(function* () {
        const { service, fs, statePath, commands, control, makeService } = yield* makeHarness();
        const plan = yield* service.install();
        const state = yield* fs.readFileString(statePath);
        const marker = `${plan.baseDir}/runtime/${SERVICE_RESTART_PENDING_FILE}`;
        yield* fs.writeFileString(marker, "1.2.3\n");
        const inside = yield* makeService(undefined, "1.2.3", undefined, true);
        commands.length = 0;
        control.failCommand = "systemctl --user daemon-reload";

        const error = yield* inside.restart.pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "BootServiceCommandError", exitCode: 1 });
        expect(commands).toEqual(["systemctl --user daemon-reload"]);
        expect(control.active).toBe(true);

        control.failCommand = undefined;
        commands.length = 0;
        const outcome = yield* inside.restart;
        expect(commands).toEqual([
          "systemctl --user daemon-reload",
          "systemctl --user enable goat.service",
          "systemctl --user restart --no-block goat.service",
        ]);
        expect(outcome).toBe("queued");
        expect(yield* fs.readFileString(statePath)).toBe(state);
        expect(yield* fs.readFileString(marker)).toBe("1.2.3\n");
      }),
  );

  it.effect("restarts an installed service when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      yield* service.install();
      commands.length = 0;
      control.failCommand = "systemctl --user daemon-reload";

      const error = yield* service.install().pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(
        commands.filter(
          (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
        ),
      ).toEqual([
        "systemctl --user stop goat.service",
        "systemctl --user daemon-reload",
        "systemctl --user restart goat.service",
      ]);
    }),
  );

  it.effect("restarts without overwriting a pending remote update", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      yield* service.install();
      const pendingState = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL - 1,
        activeVersion: "1.2.3",
        update: {
          id: "remote-update",
          fromVersion: "1.2.3",
          targetVersion: "1.2.4",
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, pendingState);
      for (const allowDowngrade of [false, true]) {
        commands.length = 0;

        expect((yield* service.install({ allowDowngrade }).pipe(Effect.flip))._tag).toBe(
          "BootServiceUpdatePendingError",
        );
        expect(serviceStateHasPendingUpdate(yield* fs.readFileString(statePath))).toBe(true);
        expect(
          commands.filter(
            (command) => command.startsWith("systemctl ") && !command.includes("show-environment"),
          ),
        ).toEqual(["systemctl --user stop goat.service", "systemctl --user restart goat.service"]);
      }
    }),
  );

  it.effect("installs, reports current state, and uninstalls on macOS", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, timeouts, runtime } = yield* makeHarness("darwin");
      const path = yield* Path.Path;
      const plan = yield* service.install();

      expect(
        plan.unitPath.endsWith(path.join("Library", "LaunchAgents", "si.goat.service.plist")),
      ).toBe(true);
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `    <key>PATH</key>\n    <string>${macInstallerPath}:/usr/local/bin:/usr/sbin:/sbin</string>`,
      );
      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.3",
      });
      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        `    <string>${runtime.entryPath}</string>\n    <string>__service-launcher</string>`,
      );
      expect(yield* service.status).toMatchObject({
        current: true,
        installedVersion: "1.2.3",
      });
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      expect(commands.some((command) => command.startsWith("systemctl "))).toBe(false);
      // A bootout can block up to the plist's 90s ExitTimeOut; the runner's
      // 60s default would cancel it and let bootstrap race a loaded job.
      expect(timeouts.get("launchctl bootout --wait gui/501/si.goat.service")).toEqual(
        Duration.seconds(120),
      );
    }),
  );

  // regression: #8173 keep provider CLIs available in the macOS service
  it.effect("reconstructs a launch agent search path when the installer has no PATH", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("darwin", "");
      const plan = yield* service.install();

      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        "    <key>PATH</key>\n    <string>/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>",
      );
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("adds missing provider directories to a minimal installer PATH", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness("darwin", "/usr/bin:/bin");
      const plan = yield* service.install();

      expect(yield* fs.readFileString(plan.unitPath)).toContain(
        "    <key>PATH</key>\n    <string>/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin</string>",
      );
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("keeps an installed launch agent current when the process PATH changes", () =>
    Effect.gen(function* () {
      const { service, makeService } = yield* makeHarness("darwin");
      yield* service.install();

      const restartedService = yield* makeService("/usr/local/bin:/usr/bin:/bin");
      expect((yield* restartedService.status).current).toBe(true);
    }),
  );

  it.effect("drops PATH directories that cannot be represented in a launch agent plist", () =>
    Effect.gen(function* () {
      const { service, fs } = yield* makeHarness(
        "darwin",
        "/opt/homebrew/bin:/Users/theo/\u0001invalid:/usr/bin",
      );
      const plan = yield* service.install();
      const plist = yield* fs.readFileString(plan.unitPath);

      expect(plist).toContain(
        "    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin</string>",
      );
      expect(plist).not.toContain("\u0001");
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("ignores a bootout for an agent that is not loaded", () =>
    Effect.gen(function* () {
      const { service, control } = yield* makeHarness("darwin");
      yield* service.install();
      control.failCommand = "launchctl bootout --wait gui/501/si.goat.service";

      yield* service.install();
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("keeps failed launch agent installs pending until activation succeeds", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands, control } = yield* makeHarness("darwin");
      const path = yield* Path.Path;
      const plan = yield* service.install();
      const markerPath = path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE);
      const bootstrap = `launchctl bootstrap gui/501 ${plan.unitPath}`;
      control.failCommand = bootstrap;

      expect((yield* service.install().pipe(Effect.flip))._tag).toBe("BootServiceCommandError");
      expect(yield* service.status).toMatchObject({
        current: false,
        problems: ["restart-pending"],
      });
      expect(yield* fs.readFileString(markerPath)).toBe("1.2.3\n");

      control.failCommand = undefined;
      commands.length = 0;
      yield* service.install();

      expect(commands).toContain(bootstrap);
      expect(yield* fs.exists(markerPath)).toBe(false);
      expect((yield* service.status).current).toBe(true);
    }),
  );
});

it("moves a legacy unit or plist to the current names without changing what it runs", () => {
  const legacyUnit = BootService.renderBootServiceUnit(
    linuxPlan,
    BootService.LEGACY_BOOT_SERVICE_NAMES,
  ).replace("Description=GOAT server", "Description=T3 Code server"); // goat-rename: legacy
  expect(BootService.migrateLegacyBootServiceUnit(legacyUnit)).toBe(
    BootService.renderBootServiceUnit(linuxPlan),
  );
  const legacyPlist = BootService.renderBootServicePlist(macPlan, {
    ...macRenderOptions,
    names: BootService.LEGACY_BOOT_SERVICE_NAMES,
  });
  expect(BootService.migrateLegacyBootServiceUnit(legacyPlist)).toBe(
    BootService.renderBootServicePlist(macPlan, macRenderOptions),
  );
});

it.layer(NodeServices.layer)("boot service legacy migration", (it) => {
  const serviceCommands = (commands: ReadonlyArray<string>) =>
    commands.filter(
      (command) => command.startsWith("systemctl --user ") && !command.endsWith("show-environment"),
    );
  const legacyUnitPath = (home: string, platform: NodeJS.Platform) =>
    platform === "darwin"
      ? `${home}/Library/LaunchAgents/${BootService.LEGACY_BOOT_SERVICE_NAMES.launchdLabel}.plist`
      : `${home}/.config/systemd/user/${BootService.LEGACY_BOOT_SERVICE_NAMES.unitFile}`;

  /** Writes a unit the way a build before the GOAT rename installed it. */
  const installLegacy = Effect.fn("test.install_legacy_boot_service")(function* (
    harness: Effect.Success<ReturnType<typeof makeHarness>>,
    platform: NodeJS.Platform,
    servedBaseDir = harness.baseDir,
  ) {
    const unitPath = legacyUnitPath(harness.home, platform);
    const plan = {
      program: [harness.runtime.entryPath, "__service-launcher"],
      baseDir: servedBaseDir,
      logPath: `${servedBaseDir}/userdata/logs/boot-service.log`,
      unitPath,
    };
    const contents =
      platform === "darwin"
        ? BootService.renderBootServicePlist(plan, {
            homeDir: harness.home,
            environmentPath: "/usr/bin",
            names: BootService.LEGACY_BOOT_SERVICE_NAMES,
          })
        : BootService.renderBootServiceUnit(plan, BootService.LEGACY_BOOT_SERVICE_NAMES);
    yield* harness.fs.makeDirectory(unitPath.slice(0, unitPath.lastIndexOf("/")), {
      recursive: true,
    });
    yield* harness.fs.writeFileString(unitPath, contents);
    yield* harness.fs.makeDirectory(`${harness.baseDir}/runtime`, { recursive: true });
    yield* harness.fs.writeFileString(
      harness.statePath,
      JSON.stringify({ protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "1.2.3" }),
    );
    return { unitPath, contents };
  });

  it.effect("install moves an owned systemd unit to goat.service", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const legacy = yield* installLegacy(harness, "linux");
      expect(yield* harness.service.status).toMatchObject({
        installed: true,
        current: false,
        installedVersion: "1.2.3",
        unitPath: legacy.unitPath,
      });

      harness.commands.length = 0;
      const plan = yield* harness.service.install();

      expect(plan.unitPath.endsWith("/goat.service")).toBe(true);
      expect(yield* harness.fs.exists(legacy.unitPath)).toBe(false);
      expect(serviceCommands(harness.commands)).toEqual([
        "systemctl --user stop t3code.service", // goat-rename: legacy
        "systemctl --user disable --now t3code.service", // goat-rename: legacy
        "systemctl --user daemon-reload",
        "systemctl --user enable goat.service",
        "systemctl --user restart goat.service",
      ]);
      expect(yield* harness.service.status).toMatchObject({ installed: true, current: true });
    }),
  );

  it.effect.each(["linux", "darwin"] as const)(
    "goat update migrates the legacy %s service to the requested runtime",
    (platform) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(platform);
        const legacy = yield* installLegacy(harness, platform);
        const targetVersion = "1.2.4";
        yield* harness.makeService(undefined, targetVersion);
        const runnerLayer = vi
          .spyOn(ProcessRunner, "layer", "get")
          .mockReturnValue(Layer.succeed(ProcessRunner.ProcessRunner, harness.runner));
        try {
          yield* Command.runWith(updateCommand, { version: "0.1.0" })([
            targetVersion,
            "--base-dir",
            harness.baseDir,
            "--yes",
          ]).pipe(
            Effect.provide(NetService.layer),
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.IsExecutable, false),
            Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/goat"),
            Effect.provideService(HostProcess.UserId, 501),
            Effect.provideService(HostProcess.Environment, {}),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { HOME: harness.home, PATH: "/usr/bin" } }),
              ),
            ),
          );
          const currentUnitPath =
            platform === "linux"
              ? `${harness.home}/.config/systemd/user/goat.service`
              : `${harness.home}/Library/LaunchAgents/si.goat.service.plist`;
          expect(yield* harness.fs.exists(legacy.unitPath)).toBe(false);
          const contents = yield* harness.fs.readFileString(currentUnitPath);
          expect(BootService.bootServiceBaseDirOf(contents)).toBe(harness.baseDir);
          expect(contents).toContain(`/versions/${targetVersion}/goat`);
          expect(harness.commands).toContain(
            platform === "linux"
              ? "systemctl --user restart goat.service"
              : `launchctl bootstrap gui/501 ${currentUnitPath}`,
          );
        } finally {
          runnerLayer.mockRestore();
        }
      }),
  );

  it.effect("regression #624: install moves the launch agent to si.goat.service, kickstarted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("darwin");
      const legacy = yield* installLegacy(harness, "darwin");

      harness.commands.length = 0;
      const plan = yield* harness.service.install();

      expect(yield* harness.fs.exists(legacy.unitPath)).toBe(false);
      expect(harness.commands.filter((command) => command.startsWith("launchctl "))).toEqual([
        "launchctl bootout --wait gui/501/com.t3tools.t3code.service", // goat-rename: legacy
        "launchctl bootout --wait gui/501/com.t3tools.t3code.service", // goat-rename: legacy
        "launchctl enable gui/501/si.goat.service",
        `launchctl bootstrap gui/501 ${plan.unitPath}`,
        "launchctl kickstart gui/501/si.goat.service",
      ]);
      expect(yield* harness.service.status).toMatchObject({ installed: true, current: true });
    }),
  );

  it.effect("leaves a legacy unit that serves another home alone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const legacy = yield* installLegacy(harness, "linux", "/home/someone/.t3-upstream");
      expect((yield* harness.service.status).installed).toBe(false);

      harness.commands.length = 0;
      yield* harness.service.install();
      expect(yield* harness.service.restart).toBe("restarted");
      expect(yield* harness.service.uninstall).toBe(true);

      expect(yield* harness.fs.readFileString(legacy.unitPath)).toBe(legacy.contents);
      expect(harness.commands.some((command) => command.includes("t3code"))).toBe(false);
    }),
  );

  it.effect("rolls back to the legacy unit when activation fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const legacy = yield* installLegacy(harness, "linux");
      harness.control.failCommand = "systemctl --user restart goat.service";
      harness.commands.length = 0;

      const error = yield* harness.service.install().pipe(Effect.flip);

      expect(error._tag).toBe("BootServiceCommandError");
      expect(yield* harness.fs.readFileString(legacy.unitPath)).toBe(legacy.contents);
      expect(yield* harness.fs.exists(`${harness.home}/.config/systemd/user/goat.service`)).toBe(
        false,
      );
      expect(harness.commands.slice(-4)).toEqual([
        "systemctl --user disable --now goat.service",
        "systemctl --user daemon-reload",
        "systemctl --user enable t3code.service", // goat-rename: legacy
        "systemctl --user restart t3code.service", // goat-rename: legacy
      ]);
    }),
  );

  it.effect("install without a start updates the legacy unit in place; restart moves it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const legacy = yield* installLegacy(harness, "linux");
      const newUnitPath = `${harness.home}/.config/systemd/user/goat.service`;

      harness.commands.length = 0;
      yield* harness.service.install({ start: false });
      expect(yield* harness.fs.exists(newUnitPath)).toBe(false);
      expect(yield* harness.fs.readFileString(legacy.unitPath)).toBe(legacy.contents);
      expect(harness.commands.some((command) => command.startsWith("systemctl --user stop"))).toBe(
        false,
      );

      harness.commands.length = 0;
      expect(yield* harness.service.restart).toBe("restarted");
      expect(yield* harness.fs.exists(legacy.unitPath)).toBe(false);
      expect(yield* harness.fs.readFileString(newUnitPath)).toBe(
        BootService.migrateLegacyBootServiceUnit(legacy.contents),
      );
      expect(serviceCommands(harness.commands)).toEqual([
        "systemctl --user stop t3code.service", // goat-rename: legacy
        "systemctl --user disable --now t3code.service", // goat-rename: legacy
        "systemctl --user daemon-reload",
        "systemctl --user enable goat.service",
        "systemctl --user restart goat.service",
      ]);
    }),
  );

  it.effect("uninstall removes an owned legacy unit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const legacy = yield* installLegacy(harness, "linux");

      expect(yield* harness.service.uninstall).toBe(true);
      expect(yield* harness.fs.exists(legacy.unitPath)).toBe(false);
      expect((yield* harness.service.status).installed).toBe(false);
    }),
  );

  it.effect("status reports restart-pending for an owned legacy unit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* installLegacy(harness, "linux");
      const path = yield* Path.Path;
      yield* harness.fs.writeFileString(
        path.join(harness.baseDir, "runtime", SERVICE_RESTART_PENDING_FILE),
        "1.2.4\n",
      );

      expect((yield* harness.service.status).problems).toContain("restart-pending");
    }),
  );

  it.effect("withStopped stops an owned legacy unit when goat.service is absent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* installLegacy(harness, "linux");
      harness.commands.length = 0;

      yield* harness.service.withStopped(Effect.sync(() => harness.commands.push("repair")));

      expect(harness.commands).toContain("systemctl --user is-active t3code.service");
      expect(harness.commands).toContain("systemctl --user stop t3code.service");
      expect(harness.commands).toContain("repair");
      expect(harness.commands).toContain("systemctl --user restart t3code.service");
      expect(harness.commands.some((command) => command.includes("goat.service"))).toBe(false);
    }),
  );

  it.effect("a migrated unit that never answers restores the previous runtime selection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const legacy = yield* installLegacy(harness, "linux");
      const beforeState = yield* harness.fs.readFileString(harness.statePath);
      const path = yield* Path.Path;
      const pending = path.join(harness.baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
      harness.control.answers = false;
      const newer = yield* harness.makeService(undefined, "1.2.4");

      const error = yield* newer.install().pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "BootServiceCommandError" });
      expect(error.message).toContain("waiting for the service to answer");
      expect(yield* harness.fs.readFileString(harness.statePath)).toBe(beforeState);
      expect(yield* harness.fs.exists(pending)).toBe(false);
      expect(yield* harness.fs.readFileString(legacy.unitPath)).toBe(legacy.contents);
      expect(yield* harness.fs.exists(`${harness.home}/.config/systemd/user/goat.service`)).toBe(
        false,
      );
    }),
  );

  it.effect("goat update still migrates a legacy unit whose state already names the target", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const legacy = yield* installLegacy(harness, "linux");
      const path = yield* Path.Path;
      const targetVersion = "1.2.4";
      yield* harness.fs.writeFileString(
        harness.statePath,
        JSON.stringify({ protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: targetVersion }),
      );
      yield* harness.fs.writeFileString(
        path.join(harness.baseDir, "runtime", SERVICE_RESTART_PENDING_FILE),
        `${targetVersion}\n`,
      );
      yield* harness.makeService(undefined, targetVersion);
      const runnerLayer = vi
        .spyOn(ProcessRunner, "layer", "get")
        .mockReturnValue(Layer.succeed(ProcessRunner.ProcessRunner, harness.runner));
      try {
        yield* Command.runWith(updateCommand, { version: "0.1.0" })([
          targetVersion,
          "--base-dir",
          harness.baseDir,
          "--yes",
        ]).pipe(
          Effect.provide(NetService.layer),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/goat"),
          Effect.provideService(HostProcess.UserId, 501),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { HOME: harness.home, PATH: "/usr/bin" } }),
            ),
          ),
        );
        expect(yield* harness.fs.exists(legacy.unitPath)).toBe(false);
        expect(yield* harness.fs.exists(`${harness.home}/.config/systemd/user/goat.service`)).toBe(
          true,
        );
      } finally {
        runnerLayer.mockRestore();
      }
    }),
  );
});
