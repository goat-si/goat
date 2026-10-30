import { ServerSettingsError, type ServerSettingsPatch } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
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

export const applyPatch = Effect.fn("ComputerUseSettings.applyPatch")(function* <A, R>(
  handoffs: Handoffs.Handoffs["Service"],
  patch: ServerSettingsPatch,
  update: Effect.Effect<A, ServerSettingsError, R>,
  settingsPath: string,
) {
  return yield* patch.enableCua === undefined && patch.cuaAllowedApps === undefined
    ? update
    : handoffs.withComputerUseSettings(patch, update).pipe(
        Effect.catchTags({
          HandoffError: (cause) =>
            Effect.fail(new ServerSettingsError({ settingsPath, operation: "normalize", cause })),
        }),
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
  const settings = yield* ServerSettings.ServerSettingsService;
  if (enabled) yield* admitEnable();
  const handoffs = yield* Effect.serviceOption(Handoffs.Handoffs);
  if (Option.isNone(handoffs)) {
    if (!enabled) yield* settings.updateSettings({ enableCua: false }, authorizeAtCommit);
    return yield* new ServerSettingsError({
      settingsPath: "computer-use",
      operation: "normalize",
      reason: "Cannot clear previous computer use sessions.",
    });
  }
  const stored = yield* applyPatch(
    handoffs.value,
    { enableCua: enabled },
    settings.updateSettings({ enableCua: enabled }, authorizeAtCommit),
    "computer-use",
  );
  return { enabled: stored.enableCua };
});
