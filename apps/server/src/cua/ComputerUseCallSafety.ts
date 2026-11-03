import { cuaAppKey, isExcludedCuaApplication } from "@goat/shared/cuaDriverManifest";
import type { ComputerUseApp } from "@goat/contracts";
import { batchAppScope, isBatchTool } from "./ComputerUseBatchScope.ts";
import { isTerminalCuaApplicationInCatalog } from "./ComputerUseTerminalApps.ts";
import { launchAlternateTarget } from "./ComputerUseLaunchTargets.ts";

export const deniedCallApp = (
  call: {
    readonly name: string;
    readonly args: unknown;
    readonly app?: string;
    readonly safetyApps?: ReadonlyArray<string>;
  },
  denied: ReadonlyArray<string>,
  nonPersonFullAccess = false,
  catalog: ReadonlyArray<ComputerUseApp> = [],
): string | undefined => {
  const keys = new Set(denied.map(cuaAppKey));
  const args =
    typeof call.args === "object" && call.args !== null && !Array.isArray(call.args)
      ? Object.entries(call.args)
      : [];
  const named =
    call.name === "launch_app"
      ? args
          .filter(
            ([key, value]) =>
              ["bundle_id", "name", "app_name"].includes(key) && typeof value === "string",
          )
          .map(([, value]) => String(value))
      : [];
  if (call.name === "launch_app" && (denied.length > 0 || nonPersonFullAccess)) {
    const alternate = launchAlternateTarget(call.args);
    if (alternate !== undefined)
      return typeof alternate[1] === "string" && alternate[1].length > 0
        ? alternate[1]
        : alternate[0];
    if (
      !args.some(
        ([key, value]) => key === "bundle_id" && typeof value === "string" && value.length > 0,
      )
    )
      return "unidentified app";
  }
  const scope = batchAppScope(call.name, call.args);
  if (isBatchTool(call.name)) {
    if (scope === undefined) return "unscoped batch";
    const resolved = new Set((call.safetyApps ?? []).map(cuaAppKey));
    const unresolved = scope.apps.find((app) => !resolved.has(cuaAppKey(app)));
    if (unresolved !== undefined) return unresolved;
  }
  const apps = [call.app, ...(call.safetyApps ?? []), ...named, ...(scope?.apps ?? [])];
  return apps.find(
    (app) =>
      app !== undefined &&
      (isExcludedCuaApplication(app) ||
        keys.has(cuaAppKey(app)) ||
        (nonPersonFullAccess && isTerminalCuaApplicationInCatalog(app, catalog))),
  );
};
