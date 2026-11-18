// @effect-diagnostics nodeBuiltinImport:off
// The unit or launch agent that goat service install wrote names the runtime that ran the install,
// and a remote update never replaces it. After a commit or rollback the launcher points it at the
// selected runtime, so the next start runs a runtime the service state records.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { guardChild } from "@goat/shared/errorGuards";

import {
  compareExactServiceVersions,
  isExactServiceVersion,
  SERVICE_UNIT_ENV,
} from "./cloud/serviceProtocol.ts";
import { acquireServiceSelectionLock } from "./cloud/serviceSelectionLock.ts";
import { bootServiceBaseDirOf, systemdUnitDirectoryOf } from "./cloud/systemdValues.ts";
import { syncDirectory } from "./serviceLauncherDatabase.ts";

export interface ServiceUnit {
  readonly path: string;
  /** systemd keeps a loaded copy of the unit; launchd re-reads the plist at bootstrap. */
  readonly reload: () => Promise<void>;
}

// The manager's environment can differ from the one it gives services (environment.d).
async function readSystemdUnitDirectory(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      "busctl",
      [
        "--user",
        "--json=short",
        "get-property",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "UnitPath",
      ],
      { timeout: 5_000, env },
    );
    const { data } = JSON.parse(stdout) as { readonly data?: unknown };
    return Array.isArray(data) && data.every((entry) => typeof entry === "string")
      ? systemdUnitDirectoryOf(data)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function serviceUnitFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceUnit | undefined> {
  const unitName = env[SERVICE_UNIT_ENV]?.trim();
  const home = env.HOME?.trim();
  if (!unitName || !home || unitName.includes("/")) return undefined;
  if (unitName.endsWith(".plist")) {
    return {
      path: NodePath.join(home, "Library", "LaunchAgents", unitName),
      reload: () => Promise.resolve(),
    };
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const unitDir =
    (await readSystemdUnitDirectory(env)) ??
    NodePath.join(
      xdgConfigHome && NodePath.isAbsolute(xdgConfigHome)
        ? xdgConfigHome
        : NodePath.join(home, ".config"),
      "systemd",
      "user",
    );
  return {
    path: NodePath.join(unitDir, unitName),
    reload: () =>
      new Promise((resolve, reject) => {
        guardChild(
          NodeChildProcess.spawn("systemctl", ["--user", "daemon-reload"], {
            stdio: "ignore",
            timeout: 30_000,
          }),
          reject,
        ).once("exit", (code, signal) =>
          code === 0
            ? resolve()
            : reject(new Error(`systemctl --user daemon-reload exited with ${code ?? signal}`)),
        );
      }),
  };
}

// systemd's ExecStart value, or the plist string before the __service-launcher argument. Only the
// version segment changes, so quoted or escaped paths stay as rendered.
const SERVICE_UNIT_PROGRAMS = [
  /^(ExecStart=.*?[\\/]runtime[\\/]goat[\\/]versions[\\/])([^\\/\s"]+)([\\/]goat)(?=["\s])/m,
  /(<string>[^<]*?[\\/]runtime[\\/]goat[\\/]versions[\\/])([^\\/<]+)([\\/]goat<\/string>\s*<string>__service-launcher<\/string>)/,
] as const;

/** Unchanged when the unit already names this version or a newer one: goat update may have moved it on. */
export function repointServiceUnitContents(contents: string, version: string): string {
  for (const program of SERVICE_UNIT_PROGRAMS) {
    const match = program.exec(contents);
    if (match === null) continue;
    const [, prefix = "", current = "", suffix = ""] = match;
    if (isExactServiceVersion(current) && compareExactServiceVersions(current, version) >= 0) {
      return contents;
    }
    return contents.replace(program, () => `${prefix}${version}${suffix}`);
  }
  return contents;
}

export async function replaceFileDurably(filePath: string, contents: string): Promise<void> {
  const directory = NodePath.dirname(filePath);
  const tempPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFSP.rename(tempPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Best effort, after the selection is durable. Under the unit's lease only: the installer takes the
 * state lease first, then the unit's. A unit serving another home, or one the selection moved past
 * since (selectionUnchanged), is left alone.
 */
export async function repointServiceUnit(input: {
  readonly unit: ServiceUnit | undefined;
  readonly baseDir: string;
  readonly version: string;
  readonly selectionUnchanged: () => Promise<boolean>;
}): Promise<void> {
  const { unit } = input;
  if (unit === undefined) return;
  try {
    const release = await acquireServiceSelectionLock(unit.path);
    try {
      if (!(await input.selectionUnchanged())) return;
      const contents = await NodeFSP.readFile(unit.path, "utf8");
      const installedBaseDir = bootServiceBaseDirOf(contents);
      if (
        installedBaseDir === undefined ||
        NodePath.resolve(installedBaseDir) !== NodePath.resolve(input.baseDir)
      ) {
        return;
      }
      const repointed = repointServiceUnitContents(contents, input.version);
      if (repointed !== contents) await replaceFileDurably(unit.path, repointed);
      // A previous rename may have succeeded before its reload failed.
      await unit.reload();
    } finally {
      release();
    }
  } catch (error) {
    process.stderr.write(
      `[service-launcher] Could not point ${unit.path} at goat@${input.version}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
