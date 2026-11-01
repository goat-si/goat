import { ServerSettingsError, type ServerSettings } from "@goat/contracts";
import { cuaAppKey, isExcludedCuaApplication } from "@goat/shared/cuaDriverManifest";
import * as Effect from "effect/Effect";

export const cleanAllowedApps = (settings: ServerSettings): ServerSettings => {
  const seen = new Set<string>();
  return {
    ...settings,
    cuaAllowedApps: settings.cuaAllowedApps.filter((app) => {
      const key = cuaAppKey(app);
      if (isExcludedCuaApplication(app) || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
};

export const rejectProtectedAllowedApps = (settings: ServerSettings) =>
  settings.cuaAllowedApps.some(isExcludedCuaApplication)
    ? Effect.fail(
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          reason: "A protected app cannot be always allowed.",
        }),
      )
    : Effect.void;
