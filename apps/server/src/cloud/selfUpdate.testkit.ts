import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as MaintenanceAudit from "../maintenance/MaintenanceAudit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

interface HarnessOptions {
  readonly baseDir?: string;
  readonly activity?: () => "idle" | "busy";
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  readonly preflightDuration?: Duration.Input;
  readonly preflightStarted?: Deferred.Deferred<void>;
  readonly beforeDownload?: Effect.Effect<void>;
  readonly corruptChecksum?: boolean;
  readonly httpClient?: HttpClient.HttpClient;
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
}

const encodePreflight = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const archiveBytes = new TextEncoder().encode("not really a tarball");
export const releaseHttpClient = (
  order: string[],
  beforeDownload?: Effect.Effect<void>,
  corruptChecksum = false,
) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.endsWith("/SHA256SUMS")) {
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes));
        const hex = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        return HttpClientResponse.fromWeb(
          request,
          new Response(`${corruptChecksum ? "0".repeat(64) : hex}  goat-1.1.0-linux-x64.tar.gz\n`),
        );
      }
      if (beforeDownload) yield* beforeDownload;
      order.push("download");
      return HttpClientResponse.fromWeb(request, new Response(archiveBytes));
    }),
  );

export const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir =
    options.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "goat-self-update-test-" }));
  const order: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "busctl")
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(1),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        if (input.command === "tar") {
          order.push("extract");
          const stagingDir = input.args[input.args.indexOf("-C") + 1];
          if (stagingDir === undefined) return yield* Effect.die("missing tar target");
          yield* fs
            .writeFileString(path.join(stagingDir, "goat"), "#!/bin/sh\n")
            .pipe(Effect.orDie);
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        if (options.preflightStarted) yield* Deferred.succeed(options.preflightStarted, undefined);
        if (options.preflightDuration !== undefined) {
          // Like the real runner, fail once the caller's timeout elapses.
          const timeout = Duration.fromInputUnsafe(input.timeout ?? "60 seconds");
          const finished = yield* Effect.sleep(options.preflightDuration).pipe(
            Effect.timeoutOption(timeout),
          );
          if (finished._tag === "None") {
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: Duration.toMillis(timeout),
            });
          }
        }
        order.push("preflight");
        const result =
          options.preflight === "blocked"
            ? { status: "blocked", version: "1.1.0", reason: "local update required" }
            : {
                status: "ready",
                version: "1.1.0",
                launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
              };
        return {
          stdout: encodePreflight(result),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    requestUpdate:
      options.requestUpdate ??
      (() =>
        Effect.sync(() => {
          order.push("accept");
          return "launcher-id";
        })),
    prepareTrial: Effect.undefined,
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const admission = yield* RuntimeAdmission.RuntimeAdmission.pipe(
    Effect.provide(RuntimeAdmission.layer),
  );
  const audit = yield* MaintenanceAudit.MaintenanceAudit.pipe(
    Effect.provide(MaintenanceAudit.layer),
    Effect.provideService(ServerConfig.ServerConfig, config),
  );
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(RuntimeAdmission.RuntimeAdmission, admission),
    Effect.provideService(MaintenanceAudit.MaintenanceAudit, audit),
    Effect.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getServerActivity: () => Effect.sync(() => options.activity?.() ?? "idle"),
      }),
    ),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(
      DesktopAppUpdate.DesktopAppUpdate,
      options.desktopAppUpdate ?? {
        available: false,
        run: () => Effect.die("unexpected desktop app update run"),
      },
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      options.httpClient ??
        releaseHttpClient(order, options.beforeDownload, options.corruptChecksum),
    ),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provide(ServerConfig.layer({ ...config, mode: options.mode ?? "web" })),
  );
  return {
    selfUpdate,
    order,
    admission,
    journal: path.join(config.stateDir, "maintenance-audit.jsonl"),
  };
});
