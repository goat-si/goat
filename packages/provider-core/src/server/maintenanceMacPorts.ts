import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
  const commandPaths = [...new Set([context.resolvedCommandPath, context.realCommandPath])];
  const portPaths = new Set<string>();
  for (const commandPath of commandPaths) {
    for (let dir = path.dirname(commandPath); ; dir = path.dirname(dir)) {
      portPaths.add(path.join(dir, "bin", "port"));
      if (path.dirname(dir) === dir) break;
    }
  }
  for (const portPath of portPaths) {
    if (!(yield* fileSystem.exists(portPath).pipe(Effect.orElseSucceed(() => false)))) continue;
    const prefix = `${normalizeCommandPath(path.dirname(path.dirname(portPath)))}/`;
    const owned = commandPaths.filter((commandPath) =>
      normalizeCommandPath(commandPath).startsWith(prefix),
    );
    if (owned.length === 0) continue;
    const output = yield* runProbe(portPath, ["provides", ...owned], context.env);
    if (output === null) return "";
    const name = /\bis provided by: (\S+)/.exec(output)?.[1];
    if (name !== undefined) return /^[\w.+-]+$/.test(name) ? name : "";
  }
  return null;
});
