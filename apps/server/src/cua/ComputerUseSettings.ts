import { ServerSettingsError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";

export const admitEnable = Effect.fn("ComputerUseSettings.admitEnable")(function* () {
  const driver = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  if (Option.isNone(driver)) return;
  const config = yield* ServerConfig.ServerConfig;
  yield* driver.value.admitEnable.pipe(
    Effect.mapError(
      (error) =>
        new ServerSettingsError({
          settingsPath: config.settingsPath,
          operation: "enable-computer-use",
          code:
            error.operation === "install"
              ? "computer_use_install_failed"
              : "computer_use_unavailable",
          reason: error.message,
        }),
    ),
  );
});

/**
 * Admission can install Cua Driver and take minutes, so the caller's grant is checked again
 * inside the settings write lock: a client revoked meanwhile cannot commit.
 */
export const setEnabled = Effect.fn("ComputerUseSettings.setEnabled")(function* (
  enabled: boolean,
  authorizeAtCommit?: Effect.Effect<void, ServerSettingsError>,
) {
  if (enabled) yield* admitEnable();
  const settings = yield* ServerSettings.ServerSettingsService;
  const stored = yield* settings.updateSettings({ enableCua: enabled }, authorizeAtCommit);
  return { enabled: stored.enableCua };
});
