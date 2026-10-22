import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerSelfUpdateError, ThreadId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
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
  readonly activity?: () => "idle" | "busy";
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  readonly beforeDownload?: Effect.Effect<void>;
  readonly corruptChecksum?: boolean;
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
}

const archiveBytes = new TextEncoder().encode("not really a tarball");
const releaseHttpClient = (
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

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-self-update-test-" });
  const order: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
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
          stdout: JSON.stringify(result),
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

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect(
    "prepares with checksum and preflight while busy, then reuses the download after idle refusal",
    () =>
      Effect.gen(function* () {
        let busy = true;
        const h = yield* makeHarness({ activity: () => (busy ? "busy" : "idle") });
        yield* h.selfUpdate.prepare("1.1.0");
        expect(h.order).toEqual(["download", "extract", "preflight"]);
        expect(yield* h.selfUpdate.isUpdating).toBe(false);
        const error = yield* h.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);
        expect(error.reason).toBe(ServerSelfUpdate.SERVER_UPDATE_BUSY_REASON);
        expect(h.order).toEqual(["download", "extract", "preflight"]);
        busy = false;
        yield* h.selfUpdate.update({ targetVersion: "1.1.0" });
        expect(h.order).toEqual(["download", "extract", "preflight", "preflight", "accept"]);
      }),
  );

  it.effect("background preparation refuses a checksum mismatch before preflight or handoff", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ corruptChecksum: true });
      yield* h.selfUpdate.prepare("1.1.0").pipe(Effect.flip);
      expect(h.order).toEqual(["download"]);
      expect(yield* h.selfUpdate.isUpdating).toBe(false);
    }),
  );

  it.effect("background preparation refuses a blocked preflight", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ preflight: "blocked" });
      const error = yield* h.selfUpdate.prepare("1.1.0").pipe(Effect.flip);
      expect(error.reason).toBe("local update required");
      expect(h.order).toEqual(["download", "extract", "preflight"]);
    }),
  );

  it.effect("background preparation and manual activation share one in-flight guard", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        beforeDownload: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });
      const fiber = yield* Effect.forkChild(h.selfUpdate.prepare("1.1.0"));
      yield* Deferred.await(entered);
      expect(yield* h.selfUpdate.isUpdating).toBe(true);
      expect(
        (yield* h.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("already in progress");
      expect((yield* h.selfUpdate.prepare("1.1.0").pipe(Effect.flip)).reason).toContain(
        "already in progress",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(yield* h.selfUpdate.isUpdating).toBe(false);
    }),
  );

  it.effect("interrupted background preparation releases the shared in-flight guard", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        beforeDownload: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = yield* Effect.forkChild(h.selfUpdate.prepare("1.1.0"));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(yield* h.selfUpdate.isUpdating).toBe(false);
      yield* h.admission.admit(Effect.void);
    }),
  );

  it.effect(
    "refuses a busy unconfirmed service without downloading or contacting the launcher",
    () =>
      Effect.gen(function* () {
        const { selfUpdate, order, admission } = yield* makeHarness({ activity: () => "busy" });
        const error = yield* selfUpdate
          .update({ targetVersion: "1.1.0", continueRunningThreads: true })
          .pipe(Effect.flip);
        expect(error.reason).toContain("running threads");
        expect(order).toEqual([]);
        yield* admission.admit(Effect.void);
      }),
  );

  it.effect("records the confirmed requester durably before launcher handoff", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let journal = "";
      const harness = yield* makeHarness({
        activity: () => "busy",
        requestUpdate: () =>
          Effect.gen(function* () {
            const lines = (yield* fs.readFileString(journal).pipe(Effect.orDie))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            expect(lines).toHaveLength(1);
            expect(lines[0]).toMatchObject({
              operation: "server-update",
              actor: { kind: "browser-session", sessionId: "requester" },
              targetVersion: "1.1.0",
              mode: "confirmed",
              outcome: "requested",
            });
            return "launcher-id";
          }),
      });
      journal = harness.journal;
      yield* harness.selfUpdate.update(
        { targetVersion: "1.1.0", confirmReplacement: true },
        undefined,
        undefined,
        { kind: "browser-session", sessionId: "requester" },
      );
      const lines = (yield* fs.readFileString(journal).pipe(Effect.orDie))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines[1]).toMatchObject({
        operationId: lines[0].operationId,
        updateId: "launcher-id",
        outcome: "accepted",
      });
      expect(yield* harness.admission.admit(Effect.void).pipe(Effect.flip)).toMatchObject({
        _tag: "ServerDrainingError",
      });
    }),
  );

  it.effect("rechecks activity after staging and reopens admission on refusal", () =>
    Effect.gen(function* () {
      let activity: "idle" | "busy" = "idle";
      const { selfUpdate, order, admission } = yield* makeHarness({
        activity: () => activity,
        beforeDownload: Effect.sync(() => {
          activity = "busy";
        }),
      });
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("running threads");
      expect(order).toEqual(["download", "extract", "preflight"]);
      yield* admission.admit(Effect.void);
    }),
  );

  it.effect("refuses handoff when the journal cannot be written and reopens admission", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { selfUpdate, journal, admission, order } = yield* makeHarness();
      yield* fs.makeDirectory(journal, { recursive: true });
      const error = yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);
      expect(error.reason).toBe("Could not record the update request.");
      expect(order).toEqual(["download", "extract", "preflight"]);
      yield* admission.admit(Effect.void);
    }),
  );

  it.effect("idle projections do not bypass an admitted dispatch", () =>
    Effect.gen(function* () {
      const { selfUpdate, admission, order } = yield* makeHarness();
      const error = yield* admission.admit(
        selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip),
      );
      expect(error.reason).toContain("running threads");
      expect(order).toEqual([]);
    }),
  );

  it.effect("marks running threads at the boot-service handoff", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          capability: "boot-service",
          isUpdating: Effect.succeed(false),
          prepare: () => Effect.void,
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({
                targetVersion: "1.1.0",
                method: "boot-service" as const,
                updateId: "update-id",
              }),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-running")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({ targetVersion: "1.1.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );

      expect(events).toEqual(["downloading", "prepare", "installing"]);
    }),
  );

  it.effect("marks desktop threads only when the prepared update commits", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-running-desktop");
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          capability: "boot-service",
          isUpdating: Effect.succeed(false),
          prepare: () => Effect.void,
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("installing").pipe(
              Effect.as({
                targetVersion: "1.2.0",
                method: "desktop-app" as const,
                desktopUpdateToken: "desktop-token",
              }),
            ),
          commitDesktopUpdate: () =>
            Effect.sync(() => events.push("commit")).pipe(Effect.andThen(Effect.fail(commitError))),
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [threadId];
        }),
        clear: (threadIds) => Effect.sync(() => void events.push(`clear:${threadIds.join(",")}`)),
      });

      yield* selfUpdate.update({ targetVersion: "1.2.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );
      expect(events).toEqual(["installing"]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual(["installing", "prepare", "commit", `clear:${threadId}`]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual([
        "installing",
        "prepare",
        "commit",
        `clear:${threadId}`,
        "prepare",
        "commit",
        `clear:${threadId}`,
      ]);
    }),
  );

  it.effect("keeps continuation markers after the boot-service handoff is accepted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          capability: "boot-service",
          isUpdating: Effect.succeed(false),
          prepare: () => Effect.void,
          update: (
            _input,
            reportProgress = () => Effect.void,
            onHandoffAccepted = () => Effect.void,
          ) =>
            reportProgress("installing").pipe(
              Effect.andThen(onHandoffAccepted()),
              Effect.andThen(Effect.interrupt),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-accepted-boot-handoff")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      const exit = yield* selfUpdate
        .update({ targetVersion: "1.1.0", continueRunningThreads: true })
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(events).toEqual(["prepare"]);
    }),
  );

  it.effect("clears continuation markers for mixed failure and interrupt causes", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          capability: "boot-service",
          isUpdating: Effect.succeed(false),
          prepare: () => Effect.void,
          update: () =>
            Effect.succeed({
              targetVersion: "1.2.0",
              method: "desktop-app" as const,
              desktopUpdateToken: "failed-desktop-token",
            }),
          commitDesktopUpdate: (_requestId, onHandoffAccepted = () => Effect.void) =>
            onHandoffAccepted().pipe(
              Effect.andThen(
                Effect.failCause(
                  Cause.fromReasons([
                    Cause.makeFailReason(commitError),
                    Cause.makeInterruptReason(),
                  ]),
                ),
              ),
            ),
        },
        prepare: Effect.sync(() => [ThreadId.make("thread-failed-desktop-install")]),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({
        targetVersion: "1.2.0",
        continueRunningThreads: true,
      });
      const exit = yield* selfUpdate.commitDesktopUpdate("failed-desktop-token").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false);
      }
      expect(events).toEqual(["clear"]);
    }),
  );

  // regression: #5181 make remote updates rollback-safe
  it.effect("rejects invalid versions and desktop-managed servers before staging", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness();
      expect(
        (yield* web.selfUpdate.update({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
      ).toBe("'latest' is not an exact goat version.");
      const desktop = yield* makeHarness({ mode: "desktop" });
      expect(
        (yield* desktop.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("desktop app");
      expect([...web.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("delegates desktop-managed updates to the desktop app when available", () =>
    Effect.gen(function* () {
      const stages: string[] = [];
      const { selfUpdate, order } = yield* makeHarness({
        mode: "desktop",
        desktopAppUpdate: {
          available: true,
          run: (reportProgress) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({ targetVersion: "1.2.0", method: "desktop-app" as const }),
            ),
          commit: () => Effect.never,
        },
      });
      const result = yield* selfUpdate.update({ targetVersion: "1.1.0" }, (stage) =>
        Effect.sync(() => void stages.push(stage)),
      );
      expect(result).toEqual({ targetVersion: "1.2.0", method: "desktop-app" });
      expect(stages).toEqual(["downloading", "installing"]);
      expect(order).toEqual([]);
    }),
  );

  it.effect("allows only one update at a time", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(requested);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.1" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* Deferred.succeed(accepted, "launcher-id");
      expect((yield* Fiber.join(first)).updateId).toBe("launcher-id");
    }),
  );

  it.effect("keeps preparing after the progress stream closes", () =>
    Effect.gen(function* () {
      const releaseDownload = yield* Deferred.make<void>();
      const sawDownloading = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        beforeDownload: Deferred.await(releaseDownload),
        requestUpdate: () =>
          Effect.sync(() => {
            order.push("accept");
          }).pipe(Effect.andThen(Deferred.succeed(accepted, undefined)), Effect.as("launcher-id")),
      });

      const consumed = yield* ServerSelfUpdate.updateProgressStream(selfUpdate, {
        targetVersion: "1.1.0",
      }).pipe(
        Stream.tap((event) =>
          event.type === "progress" && event.stage === "downloading"
            ? Deferred.succeed(sawDownloading, undefined)
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkChild,
      );

      yield* Deferred.await(sawDownloading);
      // The socket drop ends the stream. The download is still held.
      yield* Fiber.interrupt(consumed);
      expect((yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );

      yield* Deferred.succeed(releaseDownload, undefined);
      // `installing` is offered only after the stream queue has shut down.
      yield* Deferred.await(accepted);
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
    }),
  );
});

it.layer(NodeServices.layer)("pruning runtimes on start", (it) => {
  const staleVersion = "0.0.1";
  const otherProcesses = ProcessRunner.ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout: "p42\nftxt\nn/bin/sh\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

  const pruneOnStart = Effect.fn("test.prune_on_start")(function* (input: {
    readonly executable: "own runtime" | "elsewhere";
    readonly managed?: boolean;
    readonly symlinkedHome?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-prune-on-start-" });
    const realHome = path.join(tempDir, "home");
    const baseDir = input.symlinkedHome ? path.join(tempDir, "linked-home") : realHome;
    const versionsDir = path.join(baseDir, "runtime", "goat", "versions");
    yield* TestClock.setTime(24 * 60 * 60 * 1000);
    for (const version of [staleVersion, packageJson.version]) {
      const directory = path.join(realHome, "runtime", "goat", "versions", version);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "goat"), "");
      const sentinel = path.join(directory, ".install-complete");
      yield* fs.writeFileString(sentinel, `${version}\n`);
      yield* fs.utimes(sentinel, 0, 0);
    }
    if (input.symlinkedHome) yield* fs.symlink(realHome, baseDir);
    // Like `process.execPath`, the running runtime is reported by its real path.
    const executablePath =
      input.executable === "own runtime"
        ? yield* fs.realPath(path.join(versionsDir, packageJson.version, "goat"))
        : "/usr/local/bin/node";
    const removed = yield* ServerSelfUpdate.pruneRuntimesOnStart({
      baseDir,
      managed: input.managed ?? false,
    }).pipe(
      Effect.provideService(HostProcess.ExecutablePath, executablePath),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(ProcessRunner.ProcessRunner, otherProcesses),
    );
    return { removed, remaining: (yield* fs.readDirectory(versionsDir)).toSorted() };
  });

  // The SSH launcher runs `goat serve` straight from the pinned runtime, with no boot service.
  it.effect("prunes for a server started from its home's pinned runtime", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "own runtime" });
      expect(removed).toEqual([staleVersion]);
      expect(remaining).toEqual([packageJson.version]);
    }),
  );

  it.effect("recognizes its runtime through a symlinked GOAT home", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "own runtime", symlinkedHome: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("prunes for a boot-service server wherever it runs from", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "elsewhere", managed: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("leaves runtimes alone for an unmanaged server started elsewhere", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "elsewhere" });
      expect(removed).toEqual([]);
      expect(remaining).toEqual([staleVersion, packageJson.version].toSorted());
    }),
  );
});
