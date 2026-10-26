import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ServerInstallation } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { CLI_NPM_PACKAGE_NAME, cliNpmExecCommand, cliNpmPackageUrl } from "@goat/shared/cliRelease";
import { isCommandAvailable } from "@goat/shared/shell";

import packageJson from "../../package.json" with { type: "json" };

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/** Detection is best-effort; callers must fail closed to a plain `goat` command. */
function detectCliRunner(entryPath: string): CliRunner | null {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/_npx/")) {
    return "npx";
  }
  if (
    path.includes("/pnpm/dlx/") ||
    path.includes("/.pnpm/dlx/") ||
    path.includes("/pnpm-cache/dlx/")
  ) {
    return "pnpm dlx";
  }
  if (path.includes("/.bun/install/cache/") || path.includes("/bunx-")) {
    return "bunx";
  }
  return null;
}

const InstallManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  bin: Schema.optionalKey(
    Schema.Struct({
      goat: Schema.optionalKey(Schema.String),
      t3: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeInstallManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallManifest));

// `t3` and `bin/t3.mjs` are launchers built before the GOAT rename. goat-rename: legacy
const POSIX_NPM_GLOBAL_ENTRY =
  /^(.*)\/lib\/node_modules\/(@goat-si\/goat|goat|t3)\/(?:dist\/bin\.mjs|bin\/(?:goat|t3)\.mjs)$/;
const WINDOWS_NPM_GLOBAL_ENTRY =
  /^(.*)\/node_modules\/(@goat-si\/goat|goat|t3)\/(bin\/(?:goat|t3)\.mjs|dist\/bin\.mjs)$/; // goat-rename: legacy

/**
 * Windows npm puts packages in `<prefix>\node_modules` and a `<prefix>\goat.cmd`
 * shim beside them, with no `lib` or `bin`. The shim naming this exact script
 * is the ownership proof. The prefix keeps the entry's own separators, since
 * it is shown to people in a PowerShell command.
 */
const resolveWindowsNpmGlobal = Effect.fn("invocation.resolveWindowsNpmGlobal")(function* (
  entry: string,
) {
  const match = WINDOWS_NPM_GLOBAL_ENTRY.exec(entry.replaceAll("\\", "/"));
  if (!match?.[1] || match[1].includes("/node_modules/")) return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prefix = entry.slice(0, match[1].length);
  const script = `node_modules/${match[2]}/${match[3]}`;
  for (const bin of ["goat", "t3"]) {
    // goat-rename: legacy
    const shim = yield* fs.readFileString(path.join(prefix, `${bin}.cmd`)).pipe(Effect.option);
    if (Option.isSome(shim) && shim.value.replaceAll("\\", "/").includes(`%dp0%/${script}`)) {
      return { kind: "npm-global", prefix } satisfies ServerInstallation;
    }
  }
  return null;
});

/**
 * The script this CLI was started through: the `goat` npm launcher that
 * downloaded and ran this executable (it names itself in
 * `GOAT_NPM_LAUNCHER_PATH`), or the Node entry script of a build run from
 * source. A standalone executable has none and reports its own path.
 *
 * The variable is inherited by everything the server spawns, so a launcher
 * counts only when its package is this exact version: a different `goat` run
 * from an agent's shell must not claim to be the npm install.
 */
export const resolveEntryPath = Effect.gen(function* () {
  const npmLauncher = (yield* HostProcess.Environment).GOAT_NPM_LAUNCHER_PATH?.trim();
  if (npmLauncher) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = yield* fs
      .readFileString(path.join(path.dirname(npmLauncher), "../package.json"))
      .pipe(Effect.flatMap(decodeInstallManifest), Effect.option);
    if (
      Option.isSome(manifest) &&
      [CLI_NPM_PACKAGE_NAME, "goat", "t3"].includes(manifest.value.name) &&
      (manifest.value.bin?.goat !== undefined || manifest.value.bin?.t3 !== undefined) &&
      manifest.value.version === packageJson.version
    ) {
      return npmLauncher;
    }
  }
  if (yield* HostProcess.IsExecutable) return yield* HostProcess.ExecutablePath;
  return (yield* HostProcess.Arguments)[1] ?? "";
});

export const resolveServerInstallation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const entry = yield* fs.realPath(yield* resolveEntryPath);
  if (platform === "win32") {
    const owned = yield* resolveWindowsNpmGlobal(entry);
    if (owned !== null) return owned;
  }
  // Matched with `/` so the layout reads the same whatever separators the host returns.
  const match =
    platform === "win32" ? null : POSIX_NPM_GLOBAL_ENTRY.exec(entry.replaceAll("\\", "/"));
  if (!match) {
    const runner = detectCliRunner(entry);
    return runner === null
      ? null
      : ({ kind: runner === "pnpm dlx" ? "pnpm-dlx" : runner } satisfies ServerInstallation);
  }
  const layoutPrefix = match[1] ?? "";
  const prefix = entry.slice(0, layoutPrefix.length) || "/";
  if (
    layoutPrefix.includes("/node_modules/") ||
    /\/(?:Cellar|Caskroom)\//i.test(layoutPrefix) ||
    /\/mise\/installs\/(?!node\/)[^/]+\//.test(layoutPrefix)
  )
    return null;

  const packageName = match[2] ?? "goat";
  const packageRoot = path.join(prefix, "lib/node_modules", packageName);
  const manifest = yield* fs
    .readFileString(path.join(packageRoot, "package.json"))
    .pipe(Effect.flatMap(decodeInstallManifest));
  if (manifest.name !== packageName || !manifest.bin) return null;
  const binName = manifest.bin.goat === undefined ? "t3" : "goat";
  const binScript = manifest.bin.goat ?? manifest.bin.t3;
  if (binScript === undefined) return null;
  const bin = yield* fs.realPath(path.join(packageRoot, binScript));
  const globalBin = yield* fs.realPath(path.join(prefix, "bin", binName));
  if (globalBin !== bin || bin !== entry) return null;
  return { kind: "npm-global", prefix } satisfies ServerInstallation;
}).pipe(Effect.orElseSucceed(() => null));

function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  const runner = detectCliRunner(input.entryPath);
  if (runner === null) {
    return `goat ${input.subcommand}`;
  }
  return `${cliNpmExecCommand(input.version)} ${input.subcommand}`;
}

export const resolveCliCommand = (subcommand: string) =>
  Effect.map(resolveEntryPath, (entryPath) =>
    formatCliCommand({ subcommand, entryPath, version: packageJson.version }),
  );

const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * Quotes `value` for PowerShell, the default Windows terminal. Always quoted,
 * so a path reads the same whether or not it holds a space. Inside double
 * quotes `"` and its typographic forms (which also end the string) double,
 * and `$` and the backtick are escaped so nothing expands.
 */
const powershellWord = (value: string) =>
  `"${value
    .replaceAll("`", "``")
    .replaceAll("$", "`$")
    .replace(/["\u201C\u201D\u201E]/g, "$&$&")}"`;

/** Quotes a word for the host's shell: POSIX, or PowerShell on Windows. */
const hostShellWord = (platform: NodeJS.Platform, value: string) =>
  platform === "win32" ? powershellWord(value) : shellWord(value);

/** npm owns its wrapper; updating the native runtime cannot change that version pin. */
export const resolveNpmUpdateCommand = Effect.fn("invocation.resolveNpmUpdateCommand")(function* (
  version: string,
) {
  const installation = yield* resolveServerInstallation;
  if (installation?.kind === "npm-global") {
    const prefix = hostShellWord(yield* HostProcess.Platform, installation.prefix);
    return `npm --prefix ${prefix} install --global ${cliNpmPackageUrl(version)}`;
  }
  const entry = yield* resolveEntryPath;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  // A Windows launcher without a proven global shim is run through `npm exec`.
  if (platform === "win32" && entry === environment.GOAT_NPM_LAUNCHER_PATH?.trim()) {
    return cliNpmExecCommand(version);
  }
  return detectCliRunner(entry) === null ? undefined : cliNpmExecCommand(version);
});

/**
 * The launcher a person can type to run this install when `goat` is not on
 * PATH: the desktop app's `goat` shim, which the app and the shim itself name in
 * `GOAT_CLI_PATH`, or a standalone binary's own path. Script installs (a
 * repo checkout) have no single launcher and keep plain `goat`.
 */
const resolveInstallLauncher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const shim = (yield* HostProcess.Environment).GOAT_CLI_PATH?.trim();
  if (shim && (yield* fs.exists(shim).pipe(Effect.orElseSucceed(() => false)))) {
    return Option.some(shim);
  }
  return (yield* HostProcess.IsExecutable)
    ? Option.some(yield* HostProcess.ExecutablePath)
    : Option.none<string>();
});

/**
 * `goat <subcommand> <args>` for a person to run on this host: `goat` when it is
 * on PATH, the package runner this process came from, or else the absolute
 * path of the launcher for this install, such as the one the desktop app
 * installs. `args` are quoted for the host's shell: POSIX, or PowerShell on
 * Windows.
 */
export const resolveHostCliCommand = Effect.fn("invocation.resolveHostCliCommand")(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const platform = yield* HostProcess.Platform;
  const withArgs = (prefix: string) =>
    [prefix, ...args.map((arg) => hostShellWord(platform, arg))].join(" ");
  const command = yield* resolveCliCommand(subcommand);
  if (command !== `goat ${subcommand}`) return { command: withArgs(command), launcher: false };
  if (yield* isCommandAvailable("goat")) return { command: withArgs(command), launcher: false };
  const launcher = yield* resolveInstallLauncher;
  if (Option.isNone(launcher)) return { command: withArgs(command), launcher: false };
  // PowerShell runs a quoted path only through the call operator.
  const quoted = hostShellWord(platform, launcher.value);
  const call = platform === "win32" ? `& ${quoted}` : quoted;
  return { command: withArgs(`${call} ${subcommand}`), launcher: true };
});

/**
 * `sudo` resets PATH on most distributions, which drops a user-installed Node
 * (nvm, fnm, a tarball) and with it `npx` or a global `goat`, so the command
 * carries PATH through unless Node is on root's PATH too. An absolute launcher
 * needs neither.
 */
export const resolveRootCliCommand = Effect.fn("invocation.resolveRootCliCommand")(function* (
  subcommand: string,
) {
  const { command, launcher } = yield* resolveHostCliCommand(subcommand);
  if (launcher) return `sudo ${command}`;
  const executablePath = yield* HostProcess.ExecutablePath;
  const systemNode = ROOT_PATH_DIRECTORIES.some((directory) =>
    executablePath.startsWith(`${directory}/`),
  );
  return systemNode ? `sudo ${command}` : `sudo env "PATH=$PATH" ${command}`;
});

const ROOT_PATH_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
