// @effect-diagnostics nodeBuiltinImport:off -- The standalone launcher shares this marker with the CLI.
// @effect-diagnostics globalDate:off -- Standalone launcher marker deadlines use the host clock.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { guardChild } from "@goat/shared/errorGuards";
import { legacyOwnerStartTimeCommand } from "./legacyServerOwner.ts";
import {
  parseLegacyServiceState,
  parseServiceState,
  SERVICE_STATE_FILE,
} from "./cloud/serviceProtocol.ts";

// Migrations count toward the trial deadline; a missed window rolls back the database.
export const SERVICE_PREPARED_TIMEOUT_MS = 30 * 60_000;
const HANDOFF_MARKER = "service-update-handoff.json";
const MAX_MARKER_BYTES = 16_384;
const markerPath = (baseDir: string) => NodePath.join(baseDir, "runtime", HANDOFF_MARKER);

const readBounded = async (file: string): Promise<string | undefined> => {
  let handle;
  try {
    handle = await NodeFSP.open(file, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_MARKER_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_MARKER_BYTES) throw new Error("Service handoff file is too large.");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
};

export const processStartIdentity = (pid: number, platform: NodeJS.Platform): Promise<string> => {
  const { command, args, env } = legacyOwnerStartTimeCommand(pid, platform);
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      command,
      args,
      { env: { ...process.env, ...env }, timeout: 2_000, maxBuffer: 4_096 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const result = stdout.trim();
        if (result === "") reject(new Error("Launcher process identity is unavailable."));
        else resolve(result);
      },
    );
    guardChild(child, reject);
  });
};

export async function writeServiceUpdateHandoff(
  baseDir: string,
  generation: string,
  launcherPid: number,
  launcherStart: string,
): Promise<void> {
  const now = Date.now();
  const path = markerPath(baseDir);
  const next = `${path}.${process.pid}.next`;
  const value = {
    launcherPid,
    launcherStart,
    generation,
    writtenAt: now,
    expiresAt: now + SERVICE_PREPARED_TIMEOUT_MS,
  };
  try {
    await NodeFSP.writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await NodeFSP.rename(next, path);
  } finally {
    await NodeFSP.rm(next, { force: true });
  }
}

export async function serviceUpdateHandoffActive(baseDir: string): Promise<boolean> {
  const path = markerPath(baseDir);
  const contents = await readBounded(path);
  if (contents === undefined) return false;
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return false;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("launcherPid" in value) ||
    !("launcherStart" in value) ||
    !("generation" in value) ||
    !("expiresAt" in value) ||
    !("writtenAt" in value)
  )
    return false;
  if (
    typeof value.launcherPid !== "number" ||
    !Number.isSafeInteger(value.launcherPid) ||
    value.launcherPid <= 0 ||
    typeof value.launcherStart !== "string" ||
    value.launcherStart.length === 0 ||
    typeof value.generation !== "string" ||
    value.generation.length === 0 ||
    typeof value.expiresAt !== "number" ||
    typeof value.writtenAt !== "number" ||
    value.expiresAt <= Date.now() ||
    value.expiresAt > value.writtenAt + SERVICE_PREPARED_TIMEOUT_MS
  )
    return false;
  const stateText = await readBounded(NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE));
  const state =
    stateText === undefined
      ? undefined
      : (parseServiceState(stateText) ?? parseLegacyServiceState(stateText));
  if (state?.update?.status !== "pending" || state.update.id !== value.generation) return false;
  try {
    process.kill(value.launcherPid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
  let launcherStart: string;
  try {
    // oxlint-disable-next-line goat/no-global-process-runtime -- The standalone launcher uses Node built-ins.
    launcherStart = await processStartIdentity(value.launcherPid, process.platform);
  } catch (error) {
    try {
      process.kill(value.launcherPid, 0);
    } catch (probeError) {
      if (probeError instanceof Error && "code" in probeError && probeError.code === "ESRCH")
        return false;
      throw probeError;
    }
    throw error;
  }
  if (launcherStart !== value.launcherStart) return false;
  const record = NodePath.join(baseDir, "userdata", "server-runtime.json");
  try {
    if ((await NodeFSP.stat(record)).mtimeMs > value.writtenAt) return false;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return true;
}

export async function removeServiceUpdateHandoff(
  baseDir: string,
  generation: string,
): Promise<void> {
  const path = markerPath(baseDir);
  const contents = await readBounded(path);
  if (contents === undefined) return;
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "generation" in value &&
    value.generation === generation
  )
    await NodeFSP.rm(path, { force: true });
}
