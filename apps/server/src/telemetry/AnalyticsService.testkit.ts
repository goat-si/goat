import type { TelemetryConsent } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

/** Settings whose writes reach subscribers, as the live service's do. */
const layerPublishingSettings = (
  consent: TelemetryConsent,
  gate?: Deferred.Deferred<void>,
  beforeRead?: () => Effect.Effect<void>,
  declineAtSnapshot = false,
) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const changes = yield* PubSub.unbounded<Effect.Success<typeof settings.getSettings>>();
      const revision = yield* Ref.make(0);
      return ServerSettings.ServerSettingsService.of({
        ...settings,
        getSettings: Effect.suspend(() =>
          beforeRead
            ? beforeRead().pipe(Effect.andThen(settings.getSettings))
            : settings.getSettings,
        ),
        withSettingsSnapshot: Effect.fn("testSettings.withSettingsSnapshot")((f) =>
          declineAtSnapshot
            ? settings
                .updateSettings({ telemetryConsent: "declined" })
                .pipe(Effect.andThen(settings.withSettingsSnapshot(f)))
            : settings.withSettingsSnapshot(f),
        ),
        updateSettings: Effect.fn("testSettings.updateSettings")(
          (
            ...args: Parameters<ServerSettings.ServerSettingsService["Service"]["updateSettings"]>
          ) =>
            settings
              .updateSettings(...args)
              .pipe(
                Effect.tap((next) =>
                  Ref.update(revision, (n) => n + 1).pipe(
                    Effect.andThen(PubSub.publish(changes, next)),
                  ),
                ),
              ),
        ),
        changesRevision: Ref.get(revision),
        subscribeChanges: PubSub.subscribe(changes).pipe(
          Effect.map((subscription) =>
            Stream.fromSubscription(subscription).pipe(
              Stream.mapEffect((next) =>
                gate ? Deferred.await(gate).pipe(Effect.as(next)) : Effect.succeed(next),
              ),
            ),
          ),
        ),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest({ telemetryConsent: consent })));

type RemoveId = (
  remove: Effect.Effect<void, PlatformError.PlatformError>,
) => Effect.Effect<void, PlatformError.PlatformError>;

/**
 * AnalyticsService for a granted install whose settings writes reach subscribers. Deleting the
 * install id runs `removeId`, which decides whether and when the real removal happens.
 */
export const layerWithdrawable = (
  client: HttpClient.HttpClient,
  removeId: RemoveId,
  gate?: Deferred.Deferred<void>,
  beforeRead?: () => Effect.Effect<void>,
  declineAtSnapshot = false,
) =>
  Layer.unwrap(
    Effect.map(ServerConfig.ServerConfig, (config) =>
      AnalyticsService.layer.pipe(
        Layer.provide(
          Layer.effect(
            FileSystem.FileSystem,
            Effect.map(FileSystem.FileSystem, (fileSystem) =>
              FileSystem.FileSystem.of({
                ...fileSystem,
                remove: Effect.fn("testFileSystem.remove")(
                  (...args: Parameters<FileSystem.FileSystem["remove"]>) =>
                    args[0] === config.anonymousIdPath
                      ? removeId(fileSystem.remove(...args))
                      : fileSystem.remove(...args),
                ),
              }),
            ),
          ),
        ),
        Layer.provideMerge(layerPublishingSettings("granted", gate, beforeRead, declineAtSnapshot)),
      ),
    ),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "goat-telemetry-withdraw-" }),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Architecture, "x64"),
        Layer.succeed(HttpClient.HttpClient, client),
      ),
    ),
  );
