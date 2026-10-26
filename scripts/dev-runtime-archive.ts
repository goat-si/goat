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
import {
  releasePackageFiles,
  updateReleasePackageVersions,
} from "./update-release-package-versions.ts";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import rootPackageJson from "../package.json" with { type: "json" };

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const absoluteNodePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

/**
 * `vp exec node` follows PATH and can ignore VP_NODE_VERSION.
 * `vp env which node` is the Node vp selected; its directory is pinned so later
 * `vp exec` / `vp run` children use it. The probe runs that binary. When which
 * is empty, `vp env exec` is the form that honors VP_NODE_VERSION.
 */
export async function pinSelectedNodeOnPath(
  env: NodeJS.ProcessEnv,
  run: (
    command: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ stdout: string }>,
): Promise<{ readonly command: string; readonly args: ReadonlyArray<string> }> {
  let located = "";
  try {
    const which = await run("vp", ["env", "which", "node"], env);
    located = which.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  } catch {
    located = "";
  }
  if (absoluteNodePath(located)) {
    env.PATH = `${NodePath.dirname(located)}${NodePath.delimiter}${env.PATH ?? ""}`;
    return { command: located, args: ["-p", "process.version"] };
  }
  return { command: "vp", args: ["env", "exec", "node", "-p", "process.version"] };
}

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
export const parseDevRuntimeArchiveArgs = (args: ReadonlyArray<string>) => {
  const { values } = NodeUtil.parseArgs({
    args,
    options: {
      arch: { type: "string" },
      "home-dir": { type: "string" },
      "node-version": { type: "string" },
      platform: { type: "string" },
      "resource-monitor-from": { type: "string" },
      version: { type: "string" },
    },
  });
  return {
    arch: values.arch,
    homeDir: values["home-dir"],
    nodeVersion: values["node-version"],
    platform: values.platform,
    resourceMonitorFrom: values["resource-monitor-from"],
    version: values.version,
  };
};
export const resolveDevRuntimeArchiveTarget = (input?: {
  readonly platform?: string | undefined;
  readonly arch?: string | undefined;
  readonly hostPlatform?: NodeJS.Platform | undefined;
  readonly hostArch?: string | undefined;
}) => {
  const hostPlatform = input?.hostPlatform ?? HostProcess.Platform.defaultValue();
  const hostArch = input?.hostArch ?? HostProcess.Architecture.defaultValue();
  const rawPlatform = input?.platform?.trim() || hostPlatform;
  const platform = (
    rawPlatform === "mac" ? "darwin" : rawPlatform === "win" ? "win32" : rawPlatform
  ) as NodeJS.Platform;
  const arch = input?.arch?.trim() || hostArch;
  const key = cliArchivePlatformKey(platform, arch);
  if (key === undefined) throw new Error(`No supported CLI archive for ${rawPlatform}-${arch}`);
  const isHostTarget = platform === hostPlatform && arch === hostArch;
  const cliPlatform = platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux";
  // SEA_TARGETS in apps/server/vite.config.ts uses `win-<arch>` rather than `win32-<arch>`.
  const exeTarget = isHostTarget ? "host" : `${platform === "win32" ? "win" : platform}-${arch}`;
  const monitorName = platform === "win32" ? "goat-resource-monitor.exe" : "goat-resource-monitor";
  const legacyMonitorName = `${LEGACY_RESOURCE_MONITOR_BINARY_NAME}${platform === "win32" ? ".exe" : ""}`;
  return {
    platform,
    arch,
    key,
    cliPlatform,
    exeTarget,
    isHostTarget,
    hostPlatform,
    hostArch,
    monitorName,
    legacyMonitorName,
  } as const;
};
const findExistingFile = async (candidates: ReadonlyArray<string>): Promise<string | undefined> => {
  for (const candidate of candidates) {
    try {
      const stat = await NodeFSP.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch (error) {
      if (!NodeUtil.types.isNativeError(error) || !("code" in error) || error.code !== "ENOENT")
        throw error;
    }
  }
  return undefined;
};
const findResourceMonitorInDirectory = async (
  rootDir: string,
  target: ReturnType<typeof resolveDevRuntimeArchiveTarget>,
  allowDirectBinary: boolean,
): Promise<string | undefined> => {
  const names = [target.monitorName, target.legacyMonitorName];
  const direct = await findExistingFile([
    ...names.map((name) => NodePath.join(rootDir, "resource-monitor", target.key, name)),
    ...names.map((name) => NodePath.join(rootDir, target.key, name)),
    ...(allowDirectBinary ? names.map((name) => NodePath.join(rootDir, name)) : []),
  ]);
  if (direct !== undefined) return direct;
  const entries = await NodeFSP.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = await findExistingFile([
      ...names.map((name) =>
        NodePath.join(rootDir, entry.name, "resource-monitor", target.key, name),
      ),
      ...names.map((name) => NodePath.join(rootDir, entry.name, target.key, name)),
    ]);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

export async function buildDevRuntimeArchive(input: {
  readonly homeDir?: string | undefined;
  readonly nodeVersion?: string | undefined;
  readonly platform?: string | undefined;
  readonly arch?: string | undefined;
  readonly resourceMonitorFrom?: string | undefined;
  readonly hostPlatform?: NodeJS.Platform | undefined;
  readonly hostArch?: string | undefined;
  /**
   * Version to stamp into the archive and the server inside it. Defaults to the manifest
   * version, which is what a source-run dev server reports. Pass the desktop build's version
   * (`<base>-dev.<time>.g<sha>`) to bundle this archive into a local desktop build.
   */
  readonly version?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly repoRoot?: string;
}) {
  const buildRoot = input.repoRoot ?? repoRoot;
  const version = input.version?.trim() || serverPackageJson.version;
  const env = { ...(input.env ?? process.env) };
  const target = resolveDevRuntimeArchiveTarget({
    platform: input.platform,
    arch: input.arch,
    hostPlatform: input.hostPlatform,
    hostArch: input.hostArch,
  });
  const { platform, arch, key, monitorName } = target;
  const resourceMonitorFrom = input.resourceMonitorFrom?.trim() || undefined;
  const selection =
    input.nodeVersion?.trim() ||
    env.VP_NODE_VERSION?.trim() ||
    (supportsSea(process.version) ? process.version.slice(1) : rootPackageJson.engines.node);
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
  const pinned = await pinSelectedNodeOnPath(env, (command, args) => run(command, [...args]));
  const probe = await run(pinned.command, [...pinned.args]);
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
  const publicationLock = NodePath.join(directory, `.goat-dev-${version}-${key}.lock`);
  let locked = false;
  // Stamp the release manifests only while the server and its executable build, so they
  // report the archive's version; the originals come back whatever happens.
  const originalManifests =
    version === serverPackageJson.version
      ? []
      : await Promise.all(
          releasePackageFiles.map(async (file) => {
            const filePath = NodePath.join(buildRoot, file);
            return [filePath, await NodeFSP.readFile(filePath, "utf8")] as const;
          }),
        );
  const restoreManifests = async () => {
    await Promise.all(originalManifests.map(([file, text]) => NodeFSP.writeFile(file, text)));
    originalManifests.length = 0;
  };
  try {
    const monitor = NodePath.join(staging, "resource-monitor", key);
    await NodeFSP.mkdir(monitor, { recursive: true });
    const monitorDestination = NodePath.join(monitor, monitorName);
    const tarCommand = cliArchiveTarCommand(HostProcess.Platform.defaultValue(), env);
    const extractMonitorFromArchive = async (archivePath: string) => {
      const extractDir = await NodeFSP.mkdtemp(NodePath.join(staging, "monitor-from-"));
      await run(tarCommand, ["-xf", archivePath, "-C", extractDir]);
      return findResourceMonitorInDirectory(extractDir, target, false);
    };
    if (resourceMonitorFrom !== undefined) {
      const sourcePath = NodePath.resolve(input.cwd ?? buildRoot, resourceMonitorFrom);
      const stat = await NodeFSP.stat(sourcePath).catch((cause: unknown) => {
        throw new Error(
          `Resource monitor source ${sourcePath} does not exist. Pass --resource-monitor-from <archive-or-binary> with a ${key} runtime archive or ${monitorName} binary.`,
          { cause },
        );
      });
      let resolvedMonitor: string | undefined;
      if (stat.isDirectory()) {
        resolvedMonitor = await findResourceMonitorInDirectory(sourcePath, target, true);
      } else if (/\.(?:tar\.gz|tgz|tar|zip)$/i.test(sourcePath)) {
        resolvedMonitor = await extractMonitorFromArchive(sourcePath);
      } else if (stat.isFile() && !sourcePath.endsWith(".sha256")) {
        resolvedMonitor = sourcePath;
      }
      if (resolvedMonitor === undefined) {
        throw new Error(
          `Resource monitor source ${sourcePath} does not contain resource-monitor/${key}/${monitorName}. Pass --resource-monitor-from <archive-or-binary> with a ${key} runtime archive or ${monitorName} binary.`,
        );
      }
      await NodeFSP.copyFile(resolvedMonitor, monitorDestination);
      if (platform !== "win32") await NodeFSP.chmod(monitorDestination, 0o755);
    } else if (!target.isHostTarget) {
      const archiveSuffix = `-${key}.${platform === "win32" ? "zip" : "tar.gz"}`;
      const currentArchiveName = cliArchiveFileName(version, key);
      const candidates = (await NodeFSP.readdir(directory))
        .filter((entry) => entry.startsWith("goat-") && entry.endsWith(archiveSuffix))
        .toSorted((left, right) =>
          left === currentArchiveName
            ? -1
            : right === currentArchiveName
              ? 1
              : right.localeCompare(left),
        );
      let resolvedMonitor: string | undefined;
      for (const candidate of candidates) {
        resolvedMonitor = await extractMonitorFromArchive(
          NodePath.join(directory, candidate),
        ).catch(() => undefined);
        if (resolvedMonitor !== undefined) break;
      }
      if (resolvedMonitor === undefined) {
        throw new Error(
          `Cross-building ${key} on ${target.hostPlatform}-${target.hostArch} requires --resource-monitor-from <archive-or-binary> (a ${key} runtime archive or ${monitorName} binary) when no previous ${key} archive exists in ${directory}.`,
        );
      }
      await NodeFSP.copyFile(resolvedMonitor, monitorDestination);
      if (platform !== "win32") await NodeFSP.chmod(monitorDestination, 0o755);
    }
    if (originalManifests.length > 0) {
      await Effect.runPromise(
        updateReleasePackageVersions(version, { rootDir: buildRoot }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
    }
    // Server build task depends on @goat/web#build and stages dist/client.
    await run(vp, ["run", "--filter", "goat", "build"]);
    await run(vp, [
      "exec",
      "node",
      "apps/server/scripts/cli.ts",
      "build-exe",
      "--target",
      target.exeTarget,
      "--verbose",
    ]);
    await restoreManifests();
    if (target.isHostTarget && resourceMonitorFrom === undefined) {
      await run("cargo", [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        "native/resource-monitor/Cargo.toml",
      ]);
      const monitorDirectory = NodePath.join(buildRoot, "native/resource-monitor/target/release");
      let monitorSource = NodePath.join(monitorDirectory, monitorName);
      try {
        await NodeFSP.access(monitorSource);
      } catch (error) {
        if (!NodeUtil.types.isNativeError(error) || !("code" in error) || error.code !== "ENOENT")
          throw error;
        monitorSource = NodePath.join(monitorDirectory, target.legacyMonitorName);
      }
      await NodeFSP.copyFile(monitorSource, monitorDestination);
    }
    await run(vp, [
      "exec",
      "node",
      "scripts/build-cli-archive.ts",
      "--platform",
      target.cliPlatform,
      "--arch",
      arch,
      "--version",
      version,
      "--resource-monitor-dir",
      NodePath.dirname(monitor),
      "--output-dir",
      staging,
    ]);
    const name = cliArchiveFileName(version, key);
    const file = NodePath.join(staging, name);
    const bytes = await NodeFSP.readFile(file);
    const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    await NodeFSP.writeFile(`${file}.sha256`, `${hash}  ${name}\n`);
    if (platform !== "win32") {
      await Effect.runPromise(
        validateSshRuntimeArchives({
          directory: staging,
          version,
          requireAll: false,
          requireSidecars: true,
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
      );
    }
    // Execute the extracted binary on host builds before touching the publication
    // lock or previous cache files; foreign-target binaries cannot run on the host.
    const extracted = NodePath.join(staging, "verify-executable");
    await NodeFSP.mkdir(extracted);
    await run(tarCommand, ["-xf", file, "-C", extracted]);
    const stem = `goat-${version}-${key}`;
    const binary = NodePath.join(extracted, stem, platform === "win32" ? "goat.exe" : "goat");
    if (target.isHostTarget) {
      const actual = (await run(binary, ["--version"], 30_000)).stdout.trim();
      const expected = `goat v${version}`;
      if (actual !== expected)
        throw new Error(
          `Runtime archive executable reported ${JSON.stringify(actual)}; expected ${expected}. Previous cache left unchanged.`,
        );
    } else {
      const binaryStat = await NodeFSP.stat(binary);
      if (!binaryStat.isFile() || (platform !== "win32" && (binaryStat.mode & 0o111) === 0)) {
        throw new Error(`Runtime archive executable ${binary} is missing or not executable.`);
      }
    }
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
      await restoreManifests();
      if (locked) await NodeFSP.rmdir(publicationLock);
    } finally {
      await NodeFSP.rm(staging, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  buildDevRuntimeArchive(parseDevRuntimeArchiveArgs(process.argv.slice(2))).then(
    (archive) => process.stdout.write(`[dev-runtime-archive] ${archive}\n`),
    (cause: unknown) => {
      process.stderr.write(`${String(cause)}\n`);
      process.exitCode = 1;
    },
  );
}
