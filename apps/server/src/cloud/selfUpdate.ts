import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
  type ThreadId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import packageJson from "../../package.json" with { type: "json" };

import { CLI_RELEASE_BASE_URL_ENV } from "@goat/shared/cliRelease";

import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as MaintenanceAudit from "../maintenance/MaintenanceAudit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  PinnedRuntimePreflightBlockedError,
  prunePinnedRuntimes,
} from "./pinnedRuntime.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export const SERVER_UPDATE_BUSY_REASON =
  "GOAT is running threads on this server, so the update waits. Try again when they finish, or update from a GOAT app that can confirm interrupting them.";

const PREFLIGHT_TIMEOUT = Duration.seconds(30);

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly capability: ServerSelfUpdateCapability | null;
    readonly isUpdating: Effect.Effect<boolean>;
    readonly prepare: (targetVersion: string) => Effect.Effect<void, ServerSelfUpdateError>;
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted?: () => Effect.Effect<void>,
      actor?: MaintenanceAudit.MaintenanceActor,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commitDesktopUpdate: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("goat/cloud/selfUpdate/ServerSelfUpdate") {}

export const withRunningThreadContinuation = Effect.fn(
  "cloud.server_self_update.withRunningThreadContinuation",
)(function* (input: {
  readonly mode: ServerConfig.RuntimeMode;
  readonly selfUpdate: ServerSelfUpdate["Service"];
  readonly prepare: Effect.Effect<ReadonlyArray<ThreadId>, ServerSelfUpdateError>;
  readonly clear: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<void, ServerSelfUpdateError>;
}) {
  const desktopContinuationTokens = yield* Ref.make(HashSet.empty<string>());
  const clearOnError = <A>(
    effect: Effect.Effect<A, ServerSelfUpdateError>,
    threadIds: () => ReadonlyArray<ThreadId>,
    handoffAccepted: () => boolean,
  ): Effect.Effect<A, ServerSelfUpdateError> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        (handoffAccepted() && Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : input.clear(threadIds())
        ).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );

  const update: ServerSelfUpdate["Service"]["update"] = (
    request,
    reportProgress = () => Effect.void,
    _onHandoffAccepted,
    actor,
  ) => {
    let prepared = false;
    let handoffAccepted = false;
    let continuationThreadIds: ReadonlyArray<ThreadId> = [];
    return clearOnError(
      input.selfUpdate
        .update(
          request,
          (stage) =>
            (request.continueRunningThreads === true &&
            input.mode !== "desktop" &&
            stage === "installing" &&
            !prepared
              ? input.prepare.pipe(
                  Effect.tap((threadIds) =>
                    Effect.sync(() => {
                      prepared = true;
                      continuationThreadIds = threadIds;
                    }),
                  ),
                  Effect.asVoid,
                )
              : Effect.void
            ).pipe(Effect.andThen(reportProgress(stage))),
          () =>
            Effect.sync(() => {
              handoffAccepted = true;
            }),
          actor,
        )
        .pipe(
          Effect.tap((result) => {
            if (
              result.method === "desktop-app" &&
              result.desktopUpdateToken !== undefined &&
              request.continueRunningThreads === true
            ) {
              return Ref.update(desktopContinuationTokens, HashSet.add(result.desktopUpdateToken));
            }
            return Effect.void;
          }),
        ),
      () => continuationThreadIds,
      () => handoffAccepted,
    );
  };

  return ServerSelfUpdate.of({
    ...input.selfUpdate,
    update,
    commitDesktopUpdate: Effect.fn("selfUpdate.commitDesktopUpdate")(function* (requestId) {
      const shouldContinue = yield* Ref.modify(desktopContinuationTokens, (tokens) => [
        HashSet.has(tokens, requestId),
        HashSet.remove(tokens, requestId),
      ]);
      let handoffAccepted = false;
      let continuationThreadIds: ReadonlyArray<ThreadId> = [];
      return yield* clearOnError(
        Effect.gen(function* () {
          continuationThreadIds = shouldContinue ? yield* input.prepare : [];
          return yield* input.selfUpdate.commitDesktopUpdate(requestId, () =>
            Effect.sync(() => {
              handoffAccepted = true;
            }),
          );
        }),
        () => continuationThreadIds,
        () => handoffAccepted,
      ).pipe(
        Effect.catchCause((cause) =>
          (shouldContinue && !handoffAccepted
            ? Ref.update(desktopContinuationTokens, HashSet.add(requestId))
            : Effect.void
          ).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
    }),
  });
});

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const inFlight = yield* Ref.make(false);
  const audit = yield* MaintenanceAudit.MaintenanceAudit;
  const admission = yield* RuntimeAdmission.RuntimeAdmission;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const crypto = yield* Crypto.Crypto;
  const requireIdle = Effect.gen(function* () {
    const activity = yield* projections
      .getServerActivity()
      .pipe(Effect.orElseSucceed(() => "busy" as const));
    if ((yield* admission.inFlight) !== 0 || activity !== "idle") {
      return yield* new ServerSelfUpdateError({
        reason: SERVER_UPDATE_BUSY_REASON,
      });
    }
  });

  // A managed server starting means its launcher has settled on a version, so runtimes left by
  // earlier updates can go.
  if (launcher.managed) {
    yield* prunePinnedRuntimes({ baseDir: serverConfig.baseDir, keep: [packageJson.version] }).pipe(
      Effect.tap((removed) =>
        removed.length === 0
          ? Effect.void
          : Effect.logInfo("Removed unused GOAT runtimes.", { versions: removed }),
      ),
      Effect.forkScoped,
    );
  }

  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const prepareRuntime = Effect.fn("cloud.server_self_update.prepare_runtime")(function* (
    targetVersion: string,
  ) {
    return yield* ensurePinnedRuntimeInstalled({
      baseDir: serverConfig.baseDir,
      version: targetVersion,
      fs,
      path,
      runner,
      httpClient,
      platform,
      arch,
      releaseBaseUrl,
      // A cached target runs unattended after activation, so its bytes must match the verified
      // install. Never for the running version, whose directory a mismatch would remove.
      verifyCachedInstall: targetVersion !== packageJson.version,
      validate: (runtime) =>
        runner
          .run({
            command: pinnedRuntimeCommand(runtime).command,
            args: [
              ...pinnedRuntimeCommand(runtime).args,
              "__service-preflight",
              "--database-path",
              serverConfig.dbPath,
              "--launcher-protocol",
              String(SERVICE_LAUNCHER_PROTOCOL),
            ],
            timeout: PREFLIGHT_TIMEOUT,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "running the staged service preflight",
                  cause,
                }),
            ),
            Effect.flatMap(
              (
                result,
              ): Effect.Effect<
                void,
                PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
              > => {
                if (result.code !== 0) {
                  return Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "running the staged service preflight",
                      exitCode: Number(result.code),
                      stdoutLength: result.stdout.length,
                      stderrLength: result.stderr.length,
                    }),
                  );
                }
                let parsed: unknown;
                try {
                  parsed = JSON.parse(result.stdout.trim());
                } catch (cause) {
                  return Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "decoding the staged service preflight",
                      cause,
                    }),
                  );
                }
                const preflight = decodeServicePreflightResult(parsed);
                if (preflight === undefined || preflight.version !== targetVersion) {
                  return Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "verifying the staged service preflight",
                    }),
                  );
                }
                return preflight.status === "ready"
                  ? Effect.void
                  : Effect.fail(
                      new PinnedRuntimePreflightBlockedError({
                        version: targetVersion,
                        reason: preflight.reason,
                      }),
                    );
              },
            ),
          ),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "PinnedRuntimePreflightBlockedError"
          ? failWith(error.reason, error)
          : failWith(`Could not prepare goat@${targetVersion}.`, error),
      ),
    );
  });

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (
    input,
    reportProgress = () => Effect.void,
    onHandoffAccepted = () => Effect.void,
    actor = { kind: "internal" },
  ) {
    if (capability === "desktop-managed") {
      if (desktopAppUpdate.available) {
        return yield* desktopAppUpdate.run(reportProgress);
      }
      return yield* failWith(
        "This server is managed by the GOAT desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      return yield* failWith(
        "Remote updates require the GOAT background service. Run `goat service install` on the server machine.",
      );
    }

    const targetVersion = input.targetVersion.trim();
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact goat version.`);
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }

    return yield* Effect.gen(function* () {
      if (input.confirmReplacement !== true) yield* requireIdle;
      yield* reportProgress("downloading");
      const paths = yield* prepareRuntime(targetVersion);

      const operationId = yield* crypto
        .randomUUIDv4()
        .pipe(
          Effect.mapError((cause) => failWith("Could not allocate an update operation ID.", cause)),
        );
      const entry = {
        operationId,
        operation: "server-update" as const,
        actor,
        fromVersion: packageJson.version,
        targetVersion,
        mode: input.confirmReplacement === true ? ("confirmed" as const) : ("idle" as const),
      };
      let accepted = false;
      const updateId = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* admission.beginDrain;
          return yield* Effect.gen(function* () {
            // Recheck after staging with admission closed so a new turn cannot race activation.
            if (input.confirmReplacement !== true) yield* requireIdle;
            yield* restore(reportProgress("installing"));
            yield* audit
              .append({ ...entry, outcome: "requested" })
              .pipe(
                Effect.mapError((cause) => failWith("Could not record the update request.", cause)),
              );
            return yield* launcher
              .requestUpdate({ targetVersion, dbPath: serverConfig.dbPath })
              .pipe(
                Effect.mapError((error) =>
                  failWith(
                    error._tag === "ServiceLauncherRejectedError"
                      ? error.reason
                      : "Could not ask the service launcher to activate the prepared update.",
                    error,
                  ),
                ),
                Effect.tap(() => {
                  accepted = true;
                  return onHandoffAccepted();
                }),
                Effect.tap((updateId) =>
                  audit
                    .append({ ...entry, updateId, outcome: "accepted" })
                    .pipe(Effect.ignore({ log: true })),
                ),
                Effect.onError(() =>
                  audit.append({ ...entry, outcome: "failed" }).pipe(Effect.ignore({ log: true })),
                ),
              );
          }).pipe(
            Effect.ensuring(Effect.suspend(() => (accepted ? Effect.void : admission.resume))),
          );
        }),
      );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId,
        targetVersion,
        runtimePath: paths.entryPath,
      });
      return { targetVersion, method: "boot-service" as const, updateId };
    }).pipe(Effect.onError(() => Ref.set(inFlight, false)));
  });

  return ServerSelfUpdate.of({
    capability,
    isUpdating: Ref.get(inFlight),
    prepare: (targetVersion) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (capability !== "boot-service" || !isExactServiceVersion(targetVersion)) {
            return yield* failWith(
              "Background preparation requires a launcher-managed server and an exact goat version.",
            );
          }
          if (yield* Ref.getAndSet(inFlight, true)) {
            return yield* failWith("A server update is already in progress.");
          }
          return yield* restore(prepareRuntime(targetVersion)).pipe(
            Effect.asVoid,
            Effect.ensuring(Ref.set(inFlight, false)),
          );
        }),
      ),
    update,
    commitDesktopUpdate: (requestId, onHandoffAccepted) =>
      desktopAppUpdate.commit(requestId, onHandoffAccepted),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(MaintenanceAudit.layer),
);

// The RPC stream used to own this fiber, so a dropped client socket interrupted
// the download. Offers after the queue shuts down are ignored; the update
// still finishes, and the in-flight guard stays as it was.
export const updateProgressStream = (
  selfUpdate: ServerSelfUpdate["Service"],
  input: ServerSelfUpdateInput,
  actor?: MaintenanceAudit.MaintenanceActor,
) =>
  Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) => {
    const offer = (event: ServerSelfUpdateProgressEvent) =>
      Queue.offer(queue, event).pipe(Effect.ignore);

    return selfUpdate
      .update(input, (stage) => offer({ type: "progress", stage }), undefined, actor)
      .pipe(
        Effect.flatMap((result) => offer({ type: "complete", result })),
        Effect.catchTags({
          ServerSelfUpdateError: (error) => Queue.fail(queue, error).pipe(Effect.ignore),
        }),
        Effect.andThen(Queue.end(queue).pipe(Effect.ignore)),
        Effect.forkDetach,
      );
  });
