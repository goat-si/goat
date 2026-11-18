import type { DesktopRuntimeInfo, DesktopUpdateChannel, DesktopUpdateState } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

export function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  disabledReason: Option.Option<string>,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopUpdateState {
  const enabled = Option.isNone(disabledReason);
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
    message: Option.getOrNull(disabledReason),
  };
}

export function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  isDebPackage: boolean;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the GOAT_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage && !args.isDebPackage) {
    return "Automatic updates on Linux require the AppImage or the .deb package.";
  }
  return null;
}

export function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

export const makeDesktopUpdateAvailability = Effect.fn("desktop.updates.makeAvailability")(
  function* (blockedInstallationReason: string | null) {
    const config = yield* DesktopConfig.DesktopConfig;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());

    const loadFeed = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
      Effect.option,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
          onSome: parseAppUpdateYml,
        }),
      ),
      Effect.flatMap((feed) => Ref.set(appUpdateYmlConfigRef, feed)),
    );

    // electron-updater uses this marker to install .deb updates with dpkg.
    const isDebPackage =
      environment.platform === "linux" && environment.isPackaged
        ? yield* fileSystem
            .readFileString(environment.path.join(environment.resourcesPath, "package-type"))
            .pipe(
              Effect.map((packageType) => packageType.trim() === "deb"),
              Effect.orElseSucceed(() => false),
            )
        : false;

    const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
      Effect.map((appUpdateYmlConfig) => Option.isSome(appUpdateYmlConfig) || config.mockUpdates),
    );

    const resolveDisabledReason = Effect.gen(function* () {
      const hasFeedConfig = yield* hasUpdateFeedConfig;
      return Option.fromNullishOr(
        getAutoUpdateDisabledReason({
          isDevelopment: environment.isDevelopment,
          isPackaged: environment.isPackaged,
          platform: environment.platform,
          appImage: Option.getOrUndefined(config.appImagePath),
          isDebPackage,
          disabledByEnv: config.disableAutoUpdate,
          hasUpdateFeedConfig: hasFeedConfig,
        }) ?? blockedInstallationReason,
      );
    });

    return { loadFeed, resolveDisabledReason };
  },
);
