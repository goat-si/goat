import { cuaAppKey, isExcludedCuaApplication } from "@goat/shared/cuaDriverManifest";
import { batchAppScope } from "./ComputerUseBatchScope.ts";

export const deniedCallApp = (
  call: {
    readonly name: string;
    readonly args: unknown;
    readonly app?: string;
    readonly safetyApps?: ReadonlyArray<string>;
  },
  denied: ReadonlyArray<string>,
  nonPersonFullAccess = false,
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
    const name = args.find(
      ([key, value]) => (key === "name" || key === "app_name") && typeof value === "string",
    );
    if (name !== undefined) return String(name[1]);
  }
  const scope = batchAppScope(call.name, call.args);
  if (scope !== undefined && (denied.length > 0 || nonPersonFullAccess)) return scope.apps[0];
  const apps = [call.app, ...(call.safetyApps ?? []), ...named, ...(scope?.apps ?? [])];
  return apps.find(
    (app) =>
      app !== undefined &&
      (isExcludedCuaApplication(app) ||
        keys.has(cuaAppKey(app)) ||
        (nonPersonFullAccess &&
          ["com.apple.terminal", "com.googlecode.iterm2", "terminal", "iterm", "iterm2"].includes(
            cuaAppKey(app),
          ))),
  );
};
