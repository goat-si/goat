import type { DesktopRuntimeInfo, DesktopUpdateChannel, DesktopUpdateState } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
export type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);

export function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
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

export function getAutoUpdateDisabledReason(args: {
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
