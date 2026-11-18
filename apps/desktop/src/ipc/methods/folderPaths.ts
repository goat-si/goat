import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import { extractDistroFromUncPath, wslUncPathToLinuxPath } from "../../wsl/wslPathParsing.ts";
import { TO_LOCAL_BACKEND_PATH_CHANNEL } from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const toLocalBackendPath = makeIpcMethod({
  channel: TO_LOCAL_BACKEND_PATH_CHANNEL,
  payload: Schema.Struct({ backendId: Schema.String, path: Schema.String }),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.folderPaths.toLocalBackendPath")(function* ({ backendId, path }) {
    if ((yield* HostProcess.Platform) !== "win32" || path.includes("\0") || path.length > 32767) {
      return null;
    }
    const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
    if (!settings.localEnvironmentEnabled) return null;

    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const instance = yield* pool.get(DesktopBackendPool.BackendInstanceId(backendId));
    if (Option.isNone(instance) || !(yield* instance.value.snapshot).ready) return null;
    const config = yield* instance.value.currentConfig;
    if (Option.isNone(config) || Option.isSome(config.value.preflightFailure)) return null;
    const distro = config.value.runningDistro;
    if (distro === undefined) return null;

    const normalized = path.replaceAll("/", "\\");
    const uncDistro = extractDistroFromUncPath(normalized);
    if (uncDistro !== null) {
      return uncDistro.toLowerCase() === distro.toLowerCase()
        ? wslUncPathToLinuxPath(normalized)
        : null;
    }
    if (!/^[a-z]:\\/i.test(normalized)) return null;

    const wsl = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const converted = Option.getOrNull(yield* wsl.windowsToWslPath(distro, normalized));
    return converted?.startsWith("/") ? converted : null;
  }),
});
