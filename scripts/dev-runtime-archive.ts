#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Local build orchestration needs Node version and atomic filesystem publication.
import { LEGACY_RESOURCE_MONITOR_BINARY_NAME } from "@goat/contracts/legacyT3Names";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { resolveWorktreeHome } from "@goat/shared/devHome";
import { resolveSpawnCommand } from "@goat/shared/shell";
import {
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
} from "@goat/shared/cliRelease";
import * as HostProcess from "@goat/shared/HostProcess";
import { DEFAULT_GOAT_HOME } from "./dev-runner.ts";
import { validateSshRuntimeArchives } from "./build-desktop-artifact.ts";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
export const supportsSea = (version: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return (
    match !== null && (Number(match[1]) > 25 || (Number(match[1]) === 25 && Number(match[2]) >= 7))
  );
};
export const resolveRuntimeArchiveHome = (input: {
  readonly cwd: string;
  readonly homeDir?: string | undefined;
  readonly ambientHome?: string | undefined;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const worktreeHome = yield* resolveWorktreeHome(input.cwd);
    return path.resolve(
      input.cwd,
      (input.homeDir?.trim() || undefined) ??
        worktreeHome ??
        (input.ambientHome?.trim() || undefined) ??
        (yield* DEFAULT_GOAT_HOME),
    );
  });

export async function buildDevRuntimeArchive(input: {
  readonly homeDir?: string | undefined;
  readonly nodeVersion?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly repoRoot?: string;
}) {
  const buildRoot = input.repoRoot ?? repoRoot;
  const env = { ...(input.env ?? process.env) };
  const platform = HostProcess.Platform.defaultValue();
  const arch = HostProcess.Architecture.defaultValue();
  const key = cliArchivePlatformKey(platform, arch);
  if (key === undefined) throw new Error(`No supported CLI archive for ${platform}-${arch}`);
  const selection =
    input.nodeVersion?.trim() ||
    env.VP_NODE_VERSION?.trim() ||
    (supportsSea(process.version) ? process.version.slice(1) : "26.8.2");
  if (!supportsSea(selection))
    throw new Error(`SEA requires Node >=25.7.0; requested ${selection}`);
  env.VP_NODE_VERSION = selection.replace(/^v/, "");
  const vp = "vp";
  const run = async (command: string, args: string[], timeout = 0) => {
    const resolved = await Effect.runPromise(
      resolveSpawnCommand(command, args, { env }).pipe(Effect.provide(NodeServices.layer)),
    );
    return execFile(resolved.command, resolved.args, {
      cwd: buildRoot,
      env,
      maxBuffer: 16 * 1024 * 1024,
      shell: resolved.shell,
      timeout,
    });
  };
  const probe = await run(vp, ["exec", "node", "-p", "process.version"]);
  if (!supportsSea(probe.stdout) || probe.stdout.trim().replace(/^v/, "") !== env.VP_NODE_VERSION)
    throw new Error(`vp selected unsuitable SEA Node: ${probe.stdout.trim()}`);
  const home = await Effect.runPromise(
    resolveRuntimeArchiveHome({
      cwd: input.cwd ?? buildRoot,
      homeDir: input.homeDir,
      ambientHome: env.GOAT_HOME,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  const directory = NodePath.join(home, "runtime", "archives");
  await NodeFSP.mkdir(directory, { recursive: true });
  // Stage on the cache filesystem so final rename cannot be an EXDEV copy.
  const staging = await NodeFSP.mkdtemp(NodePath.join(directory, ".goat-dev-"));
  const publicationLock = NodePath.join(
    directory,
    `.goat-dev-${serverPackageJson.version}-${key}.lock`,
  );
  let locked = false;
  try {
    const monitor = NodePath.join(staging, "resource-monitor", key);
    await NodeFSP.mkdir(monitor, { recursive: true });
    // Server build task depends on @goat/web#build and stages dist/client.
    await run(vp, ["run", "--filter", "goat", "build"]);
    await run(vp, [
      "exec",
      "node",
      "apps/server/scripts/cli.ts",
      "build-exe",
      "--target",
      "host",
      "--verbose",
    ]);
    await run("cargo", [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      "native/resource-monitor/Cargo.toml",
    ]);
    const monitorName =
      platform === "win32" ? "goat-resource-monitor.exe" : "goat-resource-monitor";
    const monitorDirectory = NodePath.join(buildRoot, "native/resource-monitor/target/release");
    let monitorSource = NodePath.join(monitorDirectory, monitorName);
    try {
      await NodeFSP.access(monitorSource);
    } catch (error) {
      if (!NodeUtil.types.isNativeError(error) || !("code" in error) || error.code !== "ENOENT")
        throw error;
      monitorSource = NodePath.join(
        monitorDirectory,
        `${LEGACY_RESOURCE_MONITOR_BINARY_NAME}${platform === "win32" ? ".exe" : ""}`,
      );
    }
    await NodeFSP.copyFile(monitorSource, NodePath.join(monitor, monitorName));
    await run(vp, [
      "exec",
      "node",
      "scripts/build-cli-archive.ts",
      "--platform",
      platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux",
      "--arch",
      arch,
      "--version",
      serverPackageJson.version,
      "--resource-monitor-dir",
      NodePath.dirname(monitor),
      "--output-dir",
      staging,
    ]);
    const name = cliArchiveFileName(serverPackageJson.version, key);
    const file = NodePath.join(staging, name);
    const bytes = await NodeFSP.readFile(file);
    const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    await NodeFSP.writeFile(`${file}.sha256`, `${hash}  ${name}\n`);
    if (platform !== "win32") {
      await Effect.runPromise(
        validateSshRuntimeArchives({
          directory: staging,
          version: serverPackageJson.version,
          requireAll: false,
          requireSidecars: true,
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      );
    }
    // This command builds only the native host archive. Execute every supported
    // host's extracted binary (including Windows), with its runtime externals,
    // before touching the publication lock or the previous cache files.
    const extracted = NodePath.join(staging, "verify-executable");
    await NodeFSP.mkdir(extracted);
    await run(cliArchiveTarCommand(platform, env), ["-xf", file, "-C", extracted]);
    const stem = `goat-${serverPackageJson.version}-${key}`;
    const binary = NodePath.join(extracted, stem, platform === "win32" ? "goat.exe" : "goat");
    const actual = (await run(binary, ["--version"], 30_000)).stdout.trim();
    const expected = `goat v${serverPackageJson.version}`;
    if (actual !== expected)
      throw new Error(
        `Runtime archive executable reported ${JSON.stringify(actual)}; expected ${expected}. Previous cache left unchanged.`,
      );
    // Sidecar first, archive last: readers fail closed during a replacement.
    // Roll back the old sidecar if archive publication fails.
    const finalFile = NodePath.join(directory, name);
    await NodeFSP.mkdir(publicationLock).catch((cause: unknown) => {
      throw new Error(
        `Another dev runtime publication owns ${publicationLock}; retry after it finishes.`,
        { cause },
      );
    });
    locked = true;
    const previousSidecar = await NodeFSP.readFile(`${finalFile}.sha256`).catch(
      (cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
        throw cause;
      },
    );
    await NodeFSP.rename(`${file}.sha256`, `${finalFile}.sha256`);
    try {
      await NodeFSP.rename(file, finalFile);
    } catch (cause) {
      if (previousSidecar === null) await NodeFSP.rm(`${finalFile}.sha256`, { force: true });
      else await NodeFSP.writeFile(`${finalFile}.sha256`, previousSidecar);
      throw cause;
    }
    return finalFile;
  } finally {
    try {
      if (locked) await NodeFSP.rmdir(publicationLock);
    } finally {
      await NodeFSP.rm(staging, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      "home-dir": { type: "string" },
      "node-version": { type: "string" },
    },
  });
  buildDevRuntimeArchive({ homeDir: values["home-dir"], nodeVersion: values["node-version"] }).then(
    (archive) => process.stdout.write(`[dev-runtime-archive] ${archive}\n`),
    (cause: unknown) => {
      process.stderr.write(`${String(cause)}\n`);
      process.exitCode = 1;
    },
  );
}
