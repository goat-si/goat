// @effect-diagnostics nodeBuiltinImport:off -- createRequire finds the platform package the way codex.js does.
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveCommandPath } from "@goat/shared/shell";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeModule from "node:module";

/**
 * An npm-style Codex install runs bin/codex.js under Node, which then runs the
 * vendor native binary. Launching that binary directly saves the Node process.
 * Each step repeats what codex.js would do; anything unexpected keeps the
 * original command.
 */

const PLATFORM_PACKAGE_BY_TARGET: Readonly<Record<string, string>> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
};

const MANAGED_BY = {
  npm: "CODEX_MANAGED_BY_NPM",
  bun: "CODEX_MANAGED_BY_BUN",
  pnpm: "CODEX_MANAGED_BY_PNPM",
  "vite-plus": "CODEX_MANAGED_BY_VITE_PLUS",
} as const;
type PackageManager = keyof typeof MANAGED_BY;

// Only Codex's Linux musl builds link jemalloc; two arenas keep each idle app-server small.
const JEMALLOC_CONF = "_RJEM_MALLOC_CONF";
const READ_LIMIT_BYTES = 64 * 1024;
// The exec, export and basedir lines @pnpm/cmd-shim writes; any other exec or export is a wrapper.
const SHIM_EXEC =
  /^\s*exec\s+(?:"\$basedir\/node(?:\.exe)?"|node(?:\.exe)?)\s+"\$basedir(?:_abs|_win)?\/([^"$`]+)"\s+"\$@"\s*$/;
const SHIM_NODE_PATH_EXPORT = /^\s*export NODE_PATH="[^`]*"\s*$/;
const SHIM_MARKER = /^# cmd-shim-target=(.+)$/;
const SHIM_LEGACY_BASEDIR = 'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")';

class UnreadableMetadata extends Data.TaggedError("UnreadableMetadata") {}

const decodeRoot = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ name: Schema.Literal("@openai/codex"), version: Schema.String }),
  ),
);
const decodeVendor = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String,
      target: Schema.String,
      entrypoint: Schema.Literal("bin/codex"),
    }),
  ),
);
const decodeVitePlus = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.Literal("@openai/codex"),
      installId: Schema.optional(Schema.String),
    }),
  ),
);

function targetTriple(platform: NodeJS.Platform, arch: NodeJS.Architecture): string | undefined {
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
  }
  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  }
  return undefined;
}

const exists = (file: string) =>
  FileSystem.FileSystem.use((fs) => fs.exists(file)).pipe(Effect.orElseSucceed(() => false));

const realPathOrUndefined = (file: string) =>
  FileSystem.FileSystem.use((fs) => fs.realPath(file)).pipe(Effect.orElseSucceed(() => undefined));

/** Reads a small regular file; FIFOs, devices and large files fail so the launch falls back. */
const readSmallFile = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file);
  if (info.type !== "File" || Number(info.size) > READ_LIMIT_BYTES)
    return yield* new UnreadableMetadata();
  return yield* fs.readFileString(file);
});

/** Spawn searches relative and empty PATH entries from the child's cwd, which this lookup cannot see. */
function foundBeforeRelativeEntries(
  entry: string,
  command: string,
  pathValue: string,
  path: Path.Path,
): boolean {
  for (const dir of pathValue.split(":")) {
    if (!path.isAbsolute(dir)) return false;
    if (path.join(dir, command) === entry) return true;
  }
  return false;
}

/** The package roots of vite-plus's active install, per codex.js's ownership check. */
const vitePlusPackageRoots = Effect.fnUntraced(function* (packagesDir: string) {
  const path = yield* Path.Path;
  const metadata = yield* readSmallFile(path.join(packagesDir, "@openai", "codex.json")).pipe(
    Effect.flatMap(decodeVitePlus),
  );
  const installId = metadata.installId ?? "";
  const installDir = installId.startsWith("#")
    ? path.join(packagesDir, "@openai/codex" + installId)
    : path.join(packagesDir, "@openai/codex", installId);
  return [
    path.join(installDir, "lib", "node_modules", "@openai", "codex"),
    path.join(installDir, "node_modules", "@openai", "codex"),
  ];
});

const isVitePlusOwned = Effect.fnUntraced(function* (dir: string, root: string) {
  const path = yield* Path.Path;
  if (path.basename(dir) !== "packages") return false;
  const roots = yield* vitePlusPackageRoots(dir).pipe(Effect.orElseSucceed(() => []));
  for (const candidate of roots) {
    if ((yield* realPathOrUndefined(candidate)) === root) return true;
  }
  return false;
});

const isPnpmOwned = Effect.fnUntraced(function* (nodeModulesDir: string, root: string) {
  const path = yield* Path.Path;
  if (!(yield* exists(path.join(nodeModulesDir, ".modules.yaml")))) return false;
  return (yield* realPathOrUndefined(path.join(nodeModulesDir, "@openai", "codex"))) === root;
});

/** codex.js's detectPackageManager, which only picks the CODEX_MANAGED_BY_* flag. */
const detectPackageManager = Effect.fnUntraced(function* (
  root: string,
  entrypointDir: string,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<PackageManager, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  for (const start of new Set([root, entrypointDir])) {
    const filesystemRoot = path.parse(start).root;
    for (let dir = start; dir !== filesystemRoot; dir = path.dirname(dir)) {
      if (yield* isVitePlusOwned(dir, root)) return "vite-plus";
      if (yield* isPnpmOwned(path.join(dir, "node_modules"), root)) return "pnpm";
    }
    if (yield* isPnpmOwned(path.join(filesystemRoot, "node_modules"), root)) return "pnpm";
  }
  if (/\bbun\//.test(env.npm_config_user_agent ?? "")) return "bun";
  if ((env.npm_execpath ?? "").includes("bun")) return "bun";
  if (path.join(root, "bin").includes(".bun/install/global")) return "bun";
  return "npm";
});

/** The script a pnpm sh shim runs, or undefined for any other script. */
const pnpmShimTarget = Effect.fnUntraced(function* (entry: string, real: string) {
  const path = yield* Path.Path;
  const lines = (yield* readSmallFile(real)).split("\n");
  if (lines[0] !== "#!/bin/sh") return undefined;
  const targets = new Set<string | undefined>();
  let marker: string | undefined;
  let legacyBasedir = false;
  for (const line of lines) {
    if (/\bexec\b/.test(line)) targets.add(SHIM_EXEC.exec(line)?.[1]);
    else if (/\bexport\b/.test(line) && !SHIM_NODE_PATH_EXPORT.test(line)) return undefined;
    marker = SHIM_MARKER.exec(line)?.[1]?.trim() ?? marker;
    legacyBasedir ||= line.trim() === SHIM_LEGACY_BASEDIR;
  }
  const [target] = targets;
  if (targets.size !== 1 || target === undefined) return undefined;
  // pnpm 11 shims resolve their own symlinks first; older ones use $0 as invoked.
  if (marker !== undefined)
    return marker === target ? path.resolve(path.dirname(real), target) : undefined;
  return legacyBasedir ? path.resolve(path.dirname(entry), target) : undefined;
});

/** The lexical codex.js path the PATH entry runs. */
const locateCodexJs = Effect.fnUntraced(function* (entry: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const real = yield* fs.realPath(entry);
  if (path.basename(real) === "codex.js") return entry;
  if (path.basename(real) === "vp" && path.basename(entry) === "codex") {
    const packagesDir = path.join(path.dirname(path.dirname(entry)), "packages");
    for (const root of yield* vitePlusPackageRoots(packagesDir)) {
      const codexJs = path.join(root, "bin", "codex.js");
      if (yield* exists(codexJs)) return codexJs;
    }
    return undefined;
  }
  return yield* pnpmShimTarget(entry, real);
});

const resolveNativeCodex = Effect.fnUntraced(function* (command: string, env: NodeJS.ProcessEnv) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const triple = targetTriple(yield* HostProcess.Platform, yield* HostProcess.Architecture);
  const platformPackage = triple === undefined ? undefined : PLATFORM_PACKAGE_BY_TARGET[triple];
  if (triple === undefined || platformPackage === undefined) return undefined;
  // A relative path would resolve against a working directory the spawn does not use.
  if (!path.isAbsolute(command) && command.includes("/")) return undefined;
  const entry = yield* resolveCommandPath(command, { env });
  if (entry === null) return undefined;
  if (
    !path.isAbsolute(command) &&
    !foundBeforeRelativeEntries(entry, command, env.PATH ?? "", path)
  )
    return undefined;
  const codexJs = yield* locateCodexJs(entry);
  if (codexJs === undefined) return undefined;
  const realCodexJs = yield* fs.realPath(codexJs);
  if (
    path.basename(realCodexJs) !== "codex.js" ||
    path.basename(path.dirname(realCodexJs)) !== "bin"
  )
    return undefined;
  const root = path.dirname(path.dirname(realCodexJs));
  const rootPackage = yield* readSmallFile(path.join(root, "package.json")).pipe(
    Effect.flatMap(decodeRoot),
  );
  const vendorRoot = yield* Effect.try(() =>
    path.join(
      path.dirname(
        NodeModule.createRequire(realCodexJs).resolve(platformPackage + "/package.json"),
      ),
      "vendor",
    ),
  ).pipe(Effect.orElseSucceed(() => path.join(root, "vendor")));
  const vendorDir = path.join(vendorRoot, triple);
  const vendor = yield* readSmallFile(path.join(vendorDir, "codex-package.json")).pipe(
    Effect.flatMap(decodeVendor),
  );
  if (vendor.version !== rootPackage.version || vendor.target !== triple) return undefined;
  const binary = yield* fs.realPath(path.join(vendorDir, vendor.entrypoint));
  const info = yield* fs.stat(binary);
  if (info.type !== "File" || (info.mode & 0o111) === 0) return undefined;
  const manager = yield* detectPackageManager(root, path.dirname(codexJs), env);
  return { binary, root, manager };
});

const nodeFileSystem = Layer.merge(NodeFileSystem.layer, NodePath.layer);

const nativeLaunch = Effect.fn("codexNativeLaunch")(function* (
  command: string,
  launchEnv: NodeJS.ProcessEnv,
) {
  const env =
    launchEnv[JEMALLOC_CONF] === undefined
      ? { ...launchEnv, [JEMALLOC_CONF]: "narenas:2" }
      : launchEnv;
  const native = yield* resolveNativeCodex(command, env).pipe(
    Effect.provide(nodeFileSystem),
    Effect.orElseSucceed(() => undefined),
  );
  if (native === undefined) return { command, env };
  const managedEnv: NodeJS.ProcessEnv = { ...env, CODEX_MANAGED_PACKAGE_ROOT: native.root };
  for (const key of Object.values(MANAGED_BY)) delete managedEnv[key];
  managedEnv[MANAGED_BY[native.manager]] = "1";
  return { command: native.binary, env: managedEnv };
});

/**
 * Points a Codex launch at the vendor native binary when its command is an
 * npm, pnpm, bun or vite-plus install of @openai/codex, and sets the env
 * codex.js would. Windows and anything unexpected keep the command.
 */
export const codexNativeLaunch = <
  Launch extends { readonly command: string; readonly env: NodeJS.ProcessEnv },
>(
  launch: Launch,
) =>
  nativeLaunch(launch.command, launch.env).pipe(
    Effect.map(({ command, env }) => ({ ...launch, command, env })),
  );
