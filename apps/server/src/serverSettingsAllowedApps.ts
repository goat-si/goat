import { ServerSettingsError, type ServerSettings } from "@goat/contracts";
import { cuaAppKey, isExcludedCuaApplication } from "@goat/shared/cuaDriverManifest";
import * as Effect from "effect/Effect";

/** Protected apps leave the list only under strict input guards; otherwise it is only deduped. */
export const cleanAllowedApps = (settings: ServerSettings): ServerSettings => {
  const seen = new Set<string>();
  return {
    ...settings,
    cuaAllowedApps: settings.cuaAllowedApps.filter((app) => {
      const key = cuaAppKey(app);
      if ((settings.cuaStrictInputGuards && isExcludedCuaApplication(app)) || seen.has(key))
        return false;
      seen.add(key);
      return true;
    }),
  };
};

/** Strict guards refuse a protected app an update adds; turning strict on keeps what was stored. */
export const rejectProtectedAllowedApps = (current: ServerSettings, next: ServerSettings) =>
  next.cuaStrictInputGuards &&
  next.cuaAllowedApps.some(
    (app) =>
      isExcludedCuaApplication(app) &&
      !current.cuaAllowedApps.some((kept) => cuaAppKey(kept) === cuaAppKey(app)),
  )
    ? Effect.fail(
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          reason: "A protected app cannot be always allowed.",
        }),
      )
    : Effect.void;
