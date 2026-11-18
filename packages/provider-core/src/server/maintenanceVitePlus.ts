import { resolveCommandPath } from "@goat/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { isVitePlusGlobalCommandPath, normalizeCommandPath } from "./maintenanceCommandPaths.ts";
import { environmentCacheKey } from "./maintenanceEnvironmentCache.ts";
import { runProbe } from "./maintenanceProbe.ts";
import type {
  ProviderMaintenanceResolutionContext,
  ProviderMaintenanceResolverServices,
} from "./maintenanceResolver.ts";

const decodeVitePlusConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ shimMode: Schema.optional(Schema.Unknown) })),
);

/** With `shimMode: "system_first"` (`vp env off`), a Vite+ shim runs the next same-named command on PATH. */
export const followVitePlusSystemFirstShim = Effect.fn("followVitePlusSystemFirstShim")(function* (
  context: ProviderMaintenanceResolutionContext,
) {
  if (!isVitePlusGlobalCommandPath(context.resolvedCommandPath)) return context;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shimDir = path.dirname(context.resolvedCommandPath);
  const dataDir = path.dirname(shimDir);
  // Without VP_HOME, the XDG layout keeps shims in `~/.local/share/vite-plus` and config in `$XDG_CONFIG_HOME/vite-plus`.
  const home = context.env.VP_HOME
    ? undefined
    : /^(.*)\/\.local\/share\/vite-plus$/.exec(dataDir.replaceAll("\\", "/"))?.[1];
  const configPaths = [
    ...(home !== undefined
      ? [path.join(context.env.XDG_CONFIG_HOME || path.join(home, ".config"), "vite-plus")]
      : []),
    dataDir,
  ].map((dir) => path.join(dir, "config.json"));
  const config = yield* Effect.firstSuccessOf(
    configPaths.map((configPath) => fileSystem.readFileString(configPath)),
  ).pipe(Effect.orElseSucceed(() => ""));
  if (Option.getOrUndefined(decodeVitePlusConfig(config))?.shimMode !== "system_first") {
    return context;
  }
  const delimiter = context.platform === "win32" ? ";" : ":";
  const dirKey = (dir: string) => normalizeCommandPath(dir).replace(/\/+$/, "");
  const shimDirKey = dirKey(shimDir);
  const env = Object.fromEntries(
    Object.entries(context.env).map(([name, value]) => [
      name,
      name.toLowerCase() === "path" && value
        ? value
            .split(delimiter)
            .filter((entry) => dirKey(entry) !== shimDirKey)
            .join(delimiter)
        : value,
    ]),
  );
  const command = path.basename(context.resolvedCommandPath).replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
  const resolvedCommandPath = yield* resolveCommandPath(command, { env });
  if (!resolvedCommandPath) return context;
  const realCommandPath = yield* fileSystem
    .realPath(resolvedCommandPath)
    .pipe(Effect.orElseSucceed(() => resolvedCommandPath));
  return { ...context, resolvedCommandPath, realCommandPath };
});

// npm names the tarball `${name}-${version}.tgz`, dropping a scope's `@` and its `/`.
function parseNpmPackVersion(stdout: string, packageName: string): string | null {
  const prefix = `${packageName.replace(/^@/, "").replace("/", "-")}-`;
  const filename = stdout.trim();
  if (!filename.startsWith(prefix) || !filename.endsWith(".tgz")) return null;
  const version = filename.slice(prefix.length, -".tgz".length);
  return version && !/\s/.test(version) ? version : null;
}

const decodeVitePlusCurrentEnv = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      node: Schema.Struct({
        source: Schema.String,
        bin_path: Schema.String,
        installed: Schema.Boolean,
      }),
    }),
  ),
);

// `vp i -g` installs through the npm beside Vite+'s managed Node, even under `vp env off`, and
// `vp env current` names that Node unless it reports a system one, which install does not use.
// Pack honours npm's min-release-age and `before`, which `npm view` ignores, and resolves
// `@latest` the way install does. `--json=false` keeps its output to the tarball name.
const resolveVitePlusInstallableLatestVersion = Effect.fn(
  "resolveVitePlusInstallableLatestVersion",
)(function* (packageName: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const path = yield* Path.Path;
  const current = yield* runProbe("vp", ["env", "current", "--json"], env);
  const node = current ? Option.getOrUndefined(decodeVitePlusCurrentEnv(current))?.node : undefined;
  if (!node?.installed || node.source === "system PATH" || !path.isAbsolute(node.bin_path)) {
    return null;
  }
  const npmPath = path.join(path.dirname(node.bin_path), platform === "win32" ? "npm.cmd" : "npm");
  const packed = yield* runProbe(
    npmPath,
    ["pack", "--dry-run", "--json=false", "--global", `${packageName}@latest`],
    env,
  );
  return packed ? parseNpmPackVersion(packed, packageName) : null;
});

export const vitePlusLatestVersion = Effect.fn("vitePlusLatestVersion")(function* (
  packageName: string,
  context: ProviderMaintenanceResolutionContext,
) {
  const services = yield* Effect.context<ProviderMaintenanceResolverServices>();
  return {
    lookup: resolveVitePlusInstallableLatestVersion(
      packageName,
      context.env,
      context.platform,
    ).pipe(Effect.provideContext(services)),
    cacheKey: ["vite-plus-global", packageName, environmentCacheKey(context.env)].join("\0"),
  };
});
