// @effect-diagnostics preferSchemaOverJson:off - Fixtures encode subprocess and readiness responses.
// @effect-diagnostics nodeBuiltinImport:off - Tests exercise native Node fixture boundaries.
import * as HostProcess from "@goat/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeHttp from "node:http";
import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";

const macInstallerPath =
  "/opt/homebrew/bin:/Users/sam/.npm-global/bin:/Users/sam/.nvm/versions/node/v22.16.0/bin:/usr/bin:/bin";

export const makeHarness = Effect.fn("test.make_boot_service_harness")(function* (
  platform: NodeJS.Platform = "linux",
  installerPath = macInstallerPath,
  xdgConfigHome?: string,
  managerXdgConfigHome = xdgConfigHome,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-boot-service-test-" });
  const managerUnitDir = path.join(
    managerXdgConfigHome !== undefined && path.isAbsolute(managerXdgConfigHome)
      ? managerXdgConfigHome
      : path.join(home, ".config"),
    "systemd",
    "user",
  );

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
    linger: string | undefined;
    managerReachable: boolean;
    busNeedsRuntimeDir: boolean;
    lingerStartsManager: boolean;
    enabled: boolean;
    active: boolean;
    startLimitHit: boolean;
    /** When false, a start command returns success but the server never answers. */
    answers: boolean;
    answeredVersion: string | undefined;
  } = {
    failCommand: undefined,
    linger: "yes",
    managerReachable: true,
    busNeedsRuntimeDir: false,
    lingerStartsManager: true,
    enabled: true,
    active: true,
    startLimitHit: false,
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
      if (command === "systemctl --user reset-failed goat.service") control.startLimitHit = false;
      const refused = control.startLimitHit && command.startsWith("systemctl --user restart ");
      const failed =
        command === control.failCommand || (refused && !command.includes("--no-block"));
      if (!failed && command === "loginctl enable-linger --no-ask-password 501") {
        control.linger = "yes";
        control.managerReachable ||= control.lingerStartsManager;
      }
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
      if (!failed && !refused && command.startsWith("systemctl --user restart ")) {
        yield* publishAnswer(path.join(managerUnitDir, "goat.service"));
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
          input.command === "busctl"
            ? JSON.stringify({
                type: "as",
                data: [
                  "/usr/lib/systemd/user",
                  `${managerUnitDir}.control`,
                  "/run/user/501/systemd/transient",
                  managerUnitDir,
                  "/etc/systemd/user",
                ],
              })
            : input.args[0] === "--version"
              ? `t3 v${/versions\/([^/]+)\//.exec(input.command)?.[1] ?? "1.2.3"}\n`
              : input.command === "loginctl" && input.args[0] === "show-user"
                ? `${control.linger ?? ""}\n`
                : input.args[1] === "is-enabled"
                  ? control.enabled
                    ? "enabled\n"
                    : "disabled\n"
                  : "",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(
          failed ||
            ((command === "systemctl --user show-environment" || input.command === "busctl") &&
              (!control.managerReachable ||
                (control.busNeedsRuntimeDir && input.env?.XDG_RUNTIME_DIR === undefined))) ||
            (input.command === "loginctl" &&
              input.args[0] === "show-user" &&
              control.linger === undefined) ||
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
    hostExecPath = "/usr/bin/goat",
    underSudo = false,
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
        host: { execPath: hostExecPath },
      });
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, platform),
          Layer.succeed(HostProcess.UserId, underSudo ? 0 : 501),
          Layer.succeed(HostProcess.ExecutablePath, hostExecPath),
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
                ...(underSudo ? { SUDO_USER: "sam" } : {}),
                ...(xdgConfigHome === undefined ? {} : { XDG_CONFIG_HOME: xdgConfigHome }),
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
