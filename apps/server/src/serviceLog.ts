// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// The service manager appends the boot service's output to one file forever; the launcher bounds it.
import * as NodeFSP from "node:fs/promises";

import { serviceUnitLogPathOf } from "./cloud/systemdValues.ts";
import type { ServiceUnit } from "./serviceUnitRepoint.ts";

const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const SERVICE_LOG_CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * The manager holds the log open for appending, so it is copied aside and emptied in place
 * rather than renamed. The copy is best effort: on a full disk the truncate frees space.
 */
export async function boundServiceLog(logPath: string): Promise<void> {
  const size = await NodeFSP.stat(logPath).then(
    (stats) => stats.size,
    () => 0,
  );
  if (size <= SERVICE_LOG_MAX_BYTES) return;
  const archivePath = `${logPath}.1`;
  const pendingArchivePath = `${archivePath}.tmp`;
  await NodeFSP.copyFile(logPath, pendingArchivePath)
    .then(() => NodeFSP.rename(pendingArchivePath, archivePath))
    .catch(() => NodeFSP.rm(pendingArchivePath, { force: true }).catch(() => undefined));
  await NodeFSP.truncate(logPath, 0).catch(() => undefined);
}

/** The file the unit that started this launcher appends its output to. */
export async function serviceLogPath(
  serviceUnit: ServiceUnit | undefined,
): Promise<string | undefined> {
  if (serviceUnit === undefined) return undefined;
  const contents = await NodeFSP.readFile(serviceUnit.path, "utf8").catch(() => undefined);
  return contents === undefined ? undefined : serviceUnitLogPathOf(contents);
}
