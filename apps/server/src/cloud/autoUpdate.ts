import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import type { ServerSelfUpdateError } from "@goat/contracts";
import packageJson from "../../package.json" with { type: "json" };
import { resolveNewestRelease } from "../cli/update.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  automaticUpdateChannel,
  classifyAutomaticTarget,
  isRolloutEligible,
  rolloutBucket,
} from "./autoUpdatePolicy.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import * as SshRuntimeAutoUpdate from "./sshRuntimeAutoUpdate.ts";

export { isRolloutEligible, rolloutBucket } from "./autoUpdatePolicy.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CHECK_INTERVAL = 6 * HOUR;
const ACTIVATION_INTERVAL = 10 * MINUTE;

/**
 * How a chosen target goes live. Launcher-managed servers use the launcher trial; a
 * client-launched SSH runtime uses the ADR-0013 drain-replacement supervisor.
 */
interface Activation {
  readonly kind: "boot-service" | "ssh-runtime";
  /** Whether this server can be replaced through this path right now. */
  readonly ready: Effect.Effect<boolean>;
  readonly isUpdating: Effect.Effect<boolean>;
  readonly failedTarget: Effect.Effect<string | undefined>;
  readonly prepare: (targetVersion: string) => Effect.Effect<void, ServerSelfUpdateError>;
  readonly activate: (
    targetVersion: string,
  ) => Effect.Effect<"requested" | "busy", ServerSelfUpdateError>;
  readonly settle: Effect.Effect<void>;
}

export class ServerAutoUpdate extends Context.Service<
  ServerAutoUpdate,
  { readonly run: Effect.Effect<void> }
>()("goat/cloud/autoUpdate/ServerAutoUpdate") {}

export const make = Effect.fn("server.auto_update.make")(function* (options?: {
  readonly ownVersion?: string;
}) {
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const sshRuntime = yield* SshRuntimeAutoUpdate.SshRuntimeAutoUpdate;
  const settings = yield* ServerSettings.ServerSettingsService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const ownVersion = options?.ownVersion ?? packageJson.version;
  const skipped = (reason: string, targetVersion?: string) =>
    Effect.logInfo("server.auto_update.skipped", { reason, targetVersion });
  const enabled = settings.getSettings.pipe(Effect.map((value) => value.automaticServerUpdates));

  const bootService: Activation = {
    kind: "boot-service",
    ready: Effect.succeed(true),
    isUpdating: selfUpdate.isUpdating,
    failedTarget: Effect.sync(() =>
      launcher.lastUpdate?.status === "failed" || launcher.lastUpdate?.status === "rolled-back"
        ? launcher.lastUpdate.targetVersion
        : undefined,
    ),
    prepare: selfUpdate.prepare,
    activate: (targetVersion) =>
      selfUpdate.update({ targetVersion }, undefined, undefined, { kind: "auto-update" }).pipe(
        Effect.as("requested" as const),
        Effect.catchTags({
          ServerSelfUpdateError: (error) =>
            error.reason === ServerSelfUpdate.SERVER_UPDATE_BUSY_REASON
              ? Effect.succeed("busy" as const)
              : Effect.fail(error),
        }),
      ),
    settle: Effect.void,
  };
  const sshActivation: Activation = {
    kind: "ssh-runtime",
    ready: sshRuntime.owned,
    isUpdating: sshRuntime.isUpdating,
    failedTarget: sshRuntime.failedTarget,
    prepare: sshRuntime.prepare,
    activate: sshRuntime.activate,
    settle: sshRuntime.clearPending,
  };

  const run = Effect.gen(function* () {
    const activation =
      selfUpdate.capability === "boot-service"
        ? bootService
        : selfUpdate.capability === null && sshRuntime.supported
          ? sshActivation
          : undefined;
    if (activation === undefined) return yield* skipped("no-activation-path");
    const channel = automaticUpdateChannel(ownVersion);
    if (channel === undefined) return yield* skipped("unpublished-or-preview-build");
    const environmentId = yield* identity.getEnvironmentId;
    let pending: string | undefined;
    const drop = Effect.suspend(() => {
      pending = undefined;
      return activation.settle;
    });
    let nextCheck = (yield* Clock.currentTimeMillis) + ACTIVATION_INTERVAL;
    let nextActivation = nextCheck;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(
        Math.max(0, Math.min(nextCheck, pending === undefined ? nextCheck : nextActivation) - now),
      );
      const tick = yield* Clock.currentTimeMillis;
      yield* Effect.gen(function* () {
        if (!(yield* enabled)) {
          yield* drop;
          nextCheck = tick + CHECK_INTERVAL;
          return yield* skipped("disabled");
        }
        if (yield* activation.isUpdating) {
          nextCheck = tick + CHECK_INTERVAL;
          nextActivation = tick + ACTIVATION_INTERVAL;
          return yield* skipped("update-in-flight");
        }
        if (!(yield* activation.ready)) {
          yield* drop;
          nextCheck = tick + CHECK_INTERVAL;
          return yield* skipped("not-replaceable");
        }
        if (tick >= nextCheck) {
          nextCheck = tick + CHECK_INTERVAL;
          const release = yield* resolveNewestRelease({ channel, baseDir: config.baseDir }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
          const targetVersion = release.version;
          yield* Effect.logInfo("server.auto_update.checked", {
            channel,
            targetVersion,
            activation: activation.kind,
          });
          const verdict = classifyAutomaticTarget({
            ownVersion,
            targetVersion,
            failedTarget: yield* activation.failedTarget,
          });
          if (verdict !== "eligible") {
            yield* skipped(verdict, targetVersion);
          } else if (
            !isRolloutEligible({
              channel,
              bucket: yield* rolloutBucket(environmentId, targetVersion).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
              ),
              publishedAt: release.publishedAt,
              now: tick,
            })
          ) {
            yield* skipped("rollout-not-eligible", targetVersion);
          } else if (pending !== targetVersion) {
            yield* activation.prepare(targetVersion);
            pending = targetVersion;
            nextActivation = tick;
            yield* Effect.logInfo("server.auto_update.prepared", {
              targetVersion,
              activation: activation.kind,
            });
          }
        }
        if (pending === undefined || tick < nextActivation) return;
        if (!(yield* enabled)) {
          yield* drop;
          return yield* skipped("disabled");
        }
        if (yield* activation.isUpdating) {
          nextActivation = (yield* Clock.currentTimeMillis) + ACTIVATION_INTERVAL;
          return yield* skipped("update-in-flight", pending);
        }
        const targetVersion = pending;
        const outcome = yield* activation.activate(targetVersion).pipe(
          Effect.catchTags({
            ServerSelfUpdateError: (error) =>
              drop.pipe(
                Effect.andThen(
                  Effect.logWarning("server.auto_update.failed", { stage: "activation", error }),
                ),
                Effect.as("failed" as const),
              ),
          }),
        );
        if (outcome === "busy") {
          nextActivation = (yield* Clock.currentTimeMillis) + ACTIVATION_INTERVAL;
          return yield* Effect.logInfo("server.auto_update.deferred-busy", { targetVersion });
        }
        if (outcome === "requested") {
          yield* drop;
          yield* Effect.logInfo("server.auto_update.requested", { targetVersion });
        }
      }).pipe(Effect.catch((error) => Effect.logWarning("server.auto_update.failed", { error })));
    }
  });
  return ServerAutoUpdate.of({ run });
});

export const layer = Layer.effect(ServerAutoUpdate, make());
