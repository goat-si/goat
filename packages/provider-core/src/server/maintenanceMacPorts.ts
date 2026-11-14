import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveCommandPath } from "@goat/shared/shell";
import { normalizeCommandPath } from "./maintenanceCommandPaths.ts";
import { runProbe } from "./maintenanceProbe.ts";
import type { ProviderMaintenanceResolutionContext } from "./maintenanceResolver.ts";

/**
 * The port that installed the executable, "" when MacPorts owns it under an unusable name,
 * or null when it does not. MacPorts prefixes are root-owned and its Claude port disables
 * `claude update`, so neither npm nor the native updater can upgrade these installs.
 */
export const resolveMacPortsOwner = Effect.fn("resolveMacPortsOwner")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  if (context.platform === "win32") return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const siblingPort = path.join(path.dirname(context.resolvedCommandPath), "port");
  const portPath = (yield* fileSystem.exists(siblingPort).pipe(Effect.orElseSucceed(() => false)))
    ? siblingPort
    : yield* resolveCommandPath("port", { env: context.env });
  if (!portPath) return null;
  const prefix = `${normalizeCommandPath(path.dirname(path.dirname(portPath)))}/`;
  if (!normalizeCommandPath(context.realCommandPath).startsWith(prefix)) return null;
  const output = yield* runProbe(portPath, ["provides", context.realCommandPath], context.env);
  const name = output ? /\bis provided by: (\S+)/.exec(output)?.[1] : undefined;
  if (name === undefined) return null;
  return /^[\w.+-]+$/.test(name) ? name : "";
});
