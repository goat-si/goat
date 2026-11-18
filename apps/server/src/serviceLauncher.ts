// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// The launcher must survive unloadable server versions; use Node built-ins without Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { guardChild, type ErrorRoute } from "@goat/shared/errorGuards";

import { adoptLegacyEnv, withLegacyEnvNames } from "@goat/contracts/legacyT3Names";

import type {
  PendingServiceUpdate,
  ServiceLauncherChildMessage,
  ServiceLauncherContext,
  ServiceLauncherParentMessage,
  ServiceState,
  ServiceUpdateRecord,
} from "./cloud/serviceProtocol.ts";
import {
  compareExactServiceVersions,
  decodeServiceLauncherChildMessage,
  isExactServiceVersion,
  parseServiceState,
  parseLegacyServiceState,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_GUARANTEES,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";
import { acquireServiceSelectionLock } from "./cloud/serviceSelectionLock.ts";
import {
  backupDatabase,
  databaseBackupBlocker,
  databasePhase,
  databaseRecoveryRequired,
  markUntrackedDatabaseOwner,
  ownerLockDir,
  pathExists,
  selectDatabaseRollback,
  type DatabaseSnapshot,
  type BackupSpaceProbe,
} from "./serviceLauncherDatabase.ts";
import { stateDirOwner } from "./serviceLauncherOwner.ts";
import {
  logDiskWait,
  readAvailableBytes,
  runtimeExists,
  runtimePaths,
  startupDiskBlocker,
} from "./serviceLauncherRuntime.ts";
import { smokeProbe } from "./serviceLauncherSmokeProbe.ts";
import { boundServiceLog, SERVICE_LOG_CHECK_INTERVAL_MS, serviceLogPath } from "./serviceLog.ts";
import {
  replaceFileDurably,
  repointServiceUnit,
  serviceUnitFromEnvironment,
  type ServiceUnit,
} from "./serviceUnitRepoint.ts";

export { databaseBackupBlocker, type BackupSpaceProbe } from "./serviceLauncherDatabase.ts";

const HANDOFF_DELAY_MS = 2_000;
/**
 * Migrations count toward it and can scale with the database: tens of GB on a cold page cache
 * take minutes. A missed window rolls back the database, so the next attempt pays the same cost.
 */
const PREPARED_TIMEOUT_MS = 30 * 60_000;
export const PROBATION_MS = 10 * 60_000;
const TERMINATE_GRACE_MS = 5_000;
const RESTORE_RETRY_MS = 5_000;
const DISK_SPACE_RETRY_MS = 30_000;
const STATE_DIR_OWNER_POLL_MS = 30_000;
// A pending update waits this long for another server to give up the home (ruling C20).
const STATE_DIR_OWNER_BOUND_MS = 10 * 60_000;
// Match SERVER_EXIT_CODE_STATE_DIR_OWNED and SERVER_EXIT_CODE_DATABASE_AHEAD
// in contracts/desktopBootstrap. The standalone launcher must stay independent
// of its Effect runtime; subprocess tests use the authoritative contract values.
const STATE_DIR_OWNED_EXIT_CODE = 78;
const DATABASE_AHEAD_EXIT_CODE = 79;

type TerminalStatus = "committed" | "rolled-back" | "failed";
type ChildRole = "active" | "trial";

interface ManagedChild {
  readonly version: string;
  role: ChildRole;
  readonly process: NodeChildProcess.ChildProcess;
  exitedAt?: number;
}

const runtimeSpawnArguments = (paths: ReturnType<typeof runtimePaths>) => ({
  command: paths.entryPath,
  args: ["serve"],
});

const MANAGED_SERVICE_ENV_NAMES = new Set([
  "PATH",
  "GOAT_HOME",
  "GOAT_BOOT_SERVICE_UNIT",
  SERVICE_LAUNCHER_CONTEXT_ENV,
]);

export async function readServiceEnvironment(
  baseDir: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  let contents: string;
  try {
    contents = await NodeFSP.readFile(NodePath.join(baseDir, SERVICE_ENV_FILE), "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return environment;
    throw cause;
  }
  for (const [name, value] of Object.entries(NodeUtil.parseEnv(contents))) {
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !MANAGED_SERVICE_ENV_NAMES.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

export async function readServiceState(filePath: string): Promise<ServiceState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  const state = parseServiceState(contents) ?? parseLegacyServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  return state;
}

export async function writeServiceState(filePath: string, state: ServiceState): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  await replaceFileDurably(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

const sameSelection = (left: ServiceState, right: ServiceState) =>
  left.activeVersion === right.activeVersion &&
  left.update?.id === right.update?.id &&
  left.update?.status === right.update?.status;

function terminalUpdate<S extends TerminalStatus>(input: {
  readonly pending: PendingServiceUpdate;
  readonly status: S;
  readonly reason?: string;
}): Exclude<ServiceUpdateRecord, PendingServiceUpdate> & { readonly status: S } {
  return {
    id: input.pending.id,
    fromVersion: input.pending.fromVersion,
    targetVersion: input.pending.targetVersion,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function sendMessage(
  child: NodeChildProcess.ChildProcess,
  message: ServiceLauncherParentMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.send === undefined) {
      reject(new Error("service child IPC is disconnected."));
      return;
    }
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

function waitForExit(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function terminateChild(
  child: NodeChildProcess.ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const force = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
  try {
    await waitForExit(child);
  } finally {
    clearTimeout(force);
  }
}

const stopMarkerPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_MARKER_FILE);
const restartPendingPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);

export class Launcher {
  readonly #baseDir: string;
  readonly #statePath: string;
  #state: ServiceState;
  #child: ManagedChild | null = null;
  #timer: NodeJS.Timeout | undefined;
  #probationTimer: NodeJS.Timeout | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #stopRequested = false;
  readonly #stopSignal = new AbortController();
  #stopping = false;
  #done = false;
  readonly #completion = Promise.withResolvers<void>();
  readonly #startupSpaceProbe: (directory: string) => Promise<number>;
  readonly #writeDiagnostic: (line: string) => void;
  readonly #backupSpaceProbe: Partial<BackupSpaceProbe> | undefined;
  readonly #probationMs: number;
  readonly #now: () => number;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #serviceUnit: ServiceUnit | undefined;
  readonly #stateDirOwnerPollMs: number;
  #stateDirFreeProbes = 0;
  #ownerBusySince: number | undefined;
  #snapshot: DatabaseSnapshot | undefined;

  constructor(
    baseDir: string,
    state: ServiceState,
    options: {
      readonly startupSpaceProbe?: (directory: string) => Promise<number>;
      readonly writeDiagnostic?: (line: string) => void;
      readonly backupSpaceProbe?: Partial<BackupSpaceProbe>;
      readonly probationMs?: number;
      readonly now?: () => number;
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly serviceUnit?: ServiceUnit;
      readonly stateDirOwnerPollMs?: number;
    } = {},
  ) {
    this.#baseDir = baseDir;
    this.#startupSpaceProbe = options.startupSpaceProbe ?? readAvailableBytes;
    this.#writeDiagnostic =
      options.writeDiagnostic ??
      ((line) => {
        NodeFS.writeSync(2, line);
      });
    this.#backupSpaceProbe = options.backupSpaceProbe;
    this.#probationMs = options.probationMs ?? PROBATION_MS;
    this.#now = options.now ?? Date.now;
    this.#environment = { ...(options.environment ?? process.env) };
    this.#serviceUnit = options.serviceUnit;
    this.#stateDirOwnerPollMs = options.stateDirOwnerPollMs ?? STATE_DIR_OWNER_POLL_MS;
    this.#statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    this.#state = state;
  }

  async run(): Promise<void> {
    const onSigterm = () => void this.stop("SIGTERM");
    const onSigint = () => void this.stop("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    let logTimer: NodeJS.Timeout | undefined;
    try {
      this.#enqueue(async () => {
        const logPath = await serviceLogPath(this.#serviceUnit);
        if (logPath !== undefined) {
          await boundServiceLog(logPath);
          logTimer = setInterval(
            () => void boundServiceLog(logPath),
            SERVICE_LOG_CHECK_INTERVAL_MS,
          ).unref();
        }
        await this.#recover();
      });
      await this.#completion.promise;
    } finally {
      clearInterval(logTimer);
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    }
  }

  #enqueue(transition: () => Promise<void>): void {
    this.#transitions = this.#transitions
      .then(transition, transition)
      .catch((cause: unknown) =>
        this.#fatal(cause instanceof Error ? cause : new Error(String(cause))),
      );
  }

  async #fatal(error: Error): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#stopping = true;
    this.#clearTimer();
    const child = this.#child?.process;
    this.#child = null;
    if (child !== undefined) await terminateChild(child);
    this.#completion.reject(error);
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    // Write synchronously on signal receipt; a terminating child needs the marker in its finalizer.
    try {
      NodeFS.writeFileSync(stopMarkerPath(this.#baseDir), "", { mode: 0o600 });
    } catch {}
    if (this.#stopRequested || this.#stopping) {
      await this.#completion.promise.catch(() => undefined);
      return;
    }
    this.#stopRequested = true;
    this.#stopSignal.abort();
    this.#clearTimer();
    this.#enqueue(async () => {
      // Let in-progress updates start replacements first; replacements observe the marker and own pre-activation tunnel cleanup.
      this.#stopping = true;
      // A rollback waiting on server-owner.lock stays pending for the next launcher.
      this.#clearTimer();
      const child = this.#child?.process;
      this.#child = null;
      if (child !== undefined) await terminateChild(child, signal);
      this.#done = true;
      this.#completion.resolve();
    });
    await this.#completion.promise.catch(() => undefined);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    clearTimeout(this.#probationTimer);
    this.#probationTimer = undefined;
  }

  async #deferForDiskSpace(
    version: string,
    dbPath: string | undefined,
    retry: () => Promise<void>,
  ): Promise<boolean> {
    if (this.#stopRequested) return true;
    const reason = await startupDiskBlocker({
      baseDir: this.#baseDir,
      statePath: this.#statePath,
      version,
      dbPath: dbPath ?? NodePath.join(this.#baseDir, "userdata", "statev2.sqlite"),
      readAvailableBytes: this.#startupSpaceProbe,
    });
    if (this.#stopRequested) return true;
    if (reason === undefined) return false;
    logDiskWait(reason, this.#writeDiagnostic);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () =>
        this.#enqueue(async () => {
          if (this.#stopRequested) return;
          if (!sameSelection(await readServiceState(this.#statePath), this.#state)) {
            throw new Error(
              "Service selection changed while waiting for disk space. Restart the service.",
            );
          }
          await retry();
        }),
      DISK_SPACE_RETRY_MS,
    );
    return true;
  }

  // Local installs replace the selection and clear its update record; an old launcher must not
  // write its own selection back over theirs.
  async #selectState(next: ServiceState): Promise<void> {
    const release = await acquireServiceSelectionLock(this.#statePath);
    try {
      if (!sameSelection(await readServiceState(this.#statePath), this.#state)) {
        throw new Error("Service selection changed. Restart the service before updating.");
      }
      await writeServiceState(this.#statePath, next);
      this.#state = next;
    } finally {
      release();
    }
  }

  #repointServiceUnit(version: string): Promise<void> {
    return repointServiceUnit({
      unit: this.#serviceUnit,
      baseDir: this.#baseDir,
      version,
      // The installer writes state before the unit under this lease; reading state needs no lease.
      selectionUnchanged: async () =>
        sameSelection(await readServiceState(this.#statePath), this.#state),
    });
  }

  async #recover(): Promise<void> {
    // Clear old stop markers to preserve future tunnels; clear restart-pending only for the awaited version to avoid CLI races.
    await NodeFSP.rm(stopMarkerPath(this.#baseDir), { force: true }).catch(() => undefined);
    await this.#clearRestartPending();
    const { update, probation } = this.#state;
    if (update?.status === "committed" && probation !== undefined) {
      await this.#returnToPrevious(
        { ...update, status: "pending", dbPath: probation.dbPath },
        "rolled-back",
        probation.rollbackReason ?? "rollback-interrupted",
      );
      return;
    }
    if (update?.status === "pending") {
      if ((await databasePhase(this.#baseDir, update.id)) !== "fresh") {
        await this.#returnToPrevious(update, "failed", "rollback-interrupted");
      } else if (!(await runtimeExists(this.#baseDir, update.targetVersion))) {
        await this.#returnToPrevious(update, "failed", "target-runtime-missing");
      } else {
        await this.#startTrial(update);
      }
      return;
    }
    try {
      await this.#startChild(this.#state.activeVersion, "active", update);
    } finally {
      if (update !== undefined) await this.#repointServiceUnit(this.#state.activeVersion);
    }
  }

  async #clearRestartPending(): Promise<void> {
    const restartPending = restartPendingPath(this.#baseDir);
    try {
      const release = await acquireServiceSelectionLock(this.#statePath);
      try {
        const awaited = (
          await NodeFSP.readFile(restartPending, "utf8").catch(() => undefined)
        )?.trim();
        if (
          sameSelection(await readServiceState(this.#statePath), this.#state) &&
          awaited !== undefined &&
          isExactServiceVersion(awaited) &&
          compareExactServiceVersions(awaited, this.#state.activeVersion) <= 0
        ) {
          await NodeFSP.rm(restartPending, { force: true });
        }
      } finally {
        release();
      }
    } catch (error) {
      process.stderr.write(
        `[service-launcher] Could not clear ${restartPending}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  async #startTrial(pending: PendingServiceUpdate): Promise<void> {
    if (
      await this.#deferForDiskSpace(pending.targetVersion, pending.dbPath, () =>
        this.#startTrial(pending),
      )
    )
      return;
    try {
      this.#snapshot = await backupDatabase(this.#baseDir, pending, this.#stopSignal.signal);
    } catch (cause) {
      if (this.#stopRequested) return;
      throw databaseRecoveryRequired(
        this.#baseDir,
        pending,
        `Could not complete the snapshot: ${String(cause)}`,
      );
    }
    if (this.#stopRequested) return;
    if (this.#snapshot === undefined) {
      await this.#returnToPrevious(pending, "failed", "db-owner-busy");
      return;
    }
    try {
      await this.#startChild(pending.targetVersion, "trial", pending);
    } catch {
      await this.#returnToPrevious(pending, "failed", "candidate-start-failed");
    }
  }

  async #startChild(version: string, role: ChildRole, update?: ServiceUpdateRecord): Promise<void> {
    if (this.#stopping) return;
    if (!(await runtimeExists(this.#baseDir, version))) {
      throw new Error(`Selected goat@${version} runtime is missing or incomplete.`);
    }
    if (this.#stopping) return;
    if (
      await this.#deferForDiskSpace(
        version,
        update?.status === "pending" ? update.dbPath : this.#state.probation?.dbPath,
        role === "trial" && update?.status === "pending"
          ? () => this.#returnToPrevious(update, "failed", "candidate-start-disk-space")
          : () => this.#startChild(version, role, update),
      )
    )
      return;
    const paths = runtimePaths(this.#baseDir, version);
    const context: ServiceLauncherContext = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      launcherProtocol: SERVICE_LAUNCHER_GUARANTEES,
      ...(role === "trial" ? { trialOwnerRefusal: true as const } : {}),
      childVersion: version,
      ...(update === undefined ? {} : { update }),
      ...(role === "active" && update?.status === "committed" && this.#state.probation !== undefined
        ? { probation: true as const }
        : {}),
    };
    const spawnArguments = runtimeSpawnArguments(paths);
    const spawned = Promise.withResolvers<void>();
    // Fails the start until the child spawns; afterwards an error is queued like its other events.
    let onChildError: ErrorRoute = spawned.reject;
    const child = guardChild(
      NodeChildProcess.spawn(spawnArguments.command, spawnArguments.args, {
        env: {
          ...this.#environment,
          ...withLegacyEnvNames({ [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context) }),
        },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      }),
      (error) => onChildError(error),
    );
    child.once("spawn", () => {
      onChildError = (error) => this.#enqueue(() => Promise.reject(error));
      spawned.resolve();
    });
    await spawned.promise;
    if (this.#stopping) {
      await terminateChild(child);
      return;
    }

    const managed: ManagedChild = {
      version,
      role,
      process: child,
    };
    this.#child = managed;
    child.on("message", (value) => {
      const message = decodeServiceLauncherChildMessage(value);
      if (message !== undefined) this.#enqueue(() => this.#handleMessage(managed, message));
    });
    child.once("exit", (code, signal) => {
      managed.exitedAt = this.#now();
      this.#enqueue(() => this.#handleExit(managed, code, signal));
    });

    if (role === "trial") {
      this.#timer = setTimeout(
        () => this.#enqueue(() => this.#handlePreparedTimeout(managed)),
        PREPARED_TIMEOUT_MS,
      );
    }
  }

  async #handleMessage(child: ManagedChild, message: ServiceLauncherChildMessage): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    if (message.type === "request-update") {
      await this.#handleUpdateRequest(child, message);
      return;
    }
    await this.#handlePrepared(child, message.updateId, message.port, message.host);
  }

  async #handleUpdateRequest(
    child: ManagedChild,
    message: Extract<ServiceLauncherChildMessage, { readonly type: "request-update" }>,
  ): Promise<void> {
    const reject = (reason: string) =>
      sendMessage(child.process, { type: "update-rejected", reason });
    if (child.role !== "active") {
      await reject("Only the active server can request an update.");
      return;
    }
    if (child.version !== this.#state.activeVersion) {
      await reject("The requesting server is not the selected active version.");
      return;
    }
    if (this.#state.update?.status === "pending") {
      await reject("Another server update is already pending.");
      return;
    }
    if (this.#state.probation !== undefined) {
      if (this.#now() >= this.#state.probation.deadline) await this.#finishProbation();
      else {
        await reject("The current update is still on probation.");
        return;
      }
    }
    if (!isExactServiceVersion(message.targetVersion)) {
      await reject("The requested target is not an exact version.");
      return;
    }
    if (compareExactServiceVersions(message.targetVersion, child.version) <= 0) {
      await reject("Remote updates must select a newer server version.");
      return;
    }
    if (!NodePath.isAbsolute(message.dbPath)) {
      await reject("The requested database path is not absolute.");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, message.targetVersion))) {
      await reject("The requested target runtime is missing or incomplete.");
      return;
    }
    // Failed checks must refuse updates rather than stop the server with unknown backup capacity.
    const backupBlocker = await databaseBackupBlocker(
      this.#baseDir,
      message.dbPath,
      this.#backupSpaceProbe,
    ).catch(
      (error: unknown) =>
        `Could not check that the database backup fits before updating: ${error instanceof Error ? error.message : String(error)}. The server was not stopped.`,
    );
    if (!child.process.connected) return;
    if (backupBlocker !== undefined) {
      await reject(backupBlocker);
      return;
    }

    const pending: PendingServiceUpdate = {
      id: NodeCrypto.randomUUID(),
      fromVersion: child.version,
      targetVersion: message.targetVersion,
      dbPath: message.dbPath,
      status: "pending",
    };
    try {
      await this.#selectState({ ...this.#state, update: pending });
    } catch (error) {
      await reject(error instanceof Error ? error.message : String(error));
      return;
    }
    await sendMessage(child.process, { type: "update-accepted", updateId: pending.id });
    this.#timer = setTimeout(() => this.#enqueue(() => this.#beginTrial(child)), HANDOFF_DELAY_MS);
  }

  async #beginTrial(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "active" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    this.#child = null;
    await terminateChild(child.process);
    await this.#startTrial(pending);
  }

  async #handlePrepared(
    child: ManagedChild,
    updateId: string,
    port?: number,
    host?: string,
  ): Promise<void> {
    const pending = this.#state.update;
    if (
      child.role !== "trial" ||
      pending?.status !== "pending" ||
      pending.id !== updateId ||
      pending.targetVersion !== child.version
    ) {
      if (child.role === "trial" && pending?.status === "pending") {
        await this.#returnToPrevious(pending, "rolled-back", "invalid-prepared", child);
        return;
      }
      throw new Error("Trial child reported prepared for an unexpected update.");
    }
    this.#clearTimer();
    if (port !== undefined) {
      const failure = await smokeProbe(port, host, pending.targetVersion);
      if (failure !== undefined) {
        await this.#returnToPrevious(pending, "rolled-back", `smoke-failed:${failure}`, child);
        return;
      }
    } else {
      process.stderr.write("[service-launcher] Trial supplied no port; skipping smoke probe.\n");
    }
    const committed = terminalUpdate({ pending, status: "committed" });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.targetVersion,
      update: committed,
      probation: { dbPath: pending.dbPath, deadline: this.#now() + this.#probationMs },
    };
    await this.#selectState(next);
    child.role = "active";
    await this.#resumeProbation();
    try {
      await sendMessage(child.process, { type: "committed", updateId: committed.id });
    } catch {
      // Exit can race the durable commit. Do not let a failed IPC acknowledgement
      // bypass probation by reaching the launcher's fatal-error path first.
      // A surviving trial fails its own bounded acknowledgement wait and exits.
      process.stderr.write(
        "[service-launcher] Commit acknowledgement failed; awaiting child exit.\n",
      );
    }
    await this.#repointServiceUnit(committed.targetVersion);
  }

  async #resumeProbation(): Promise<void> {
    if (this.#stopping || this.#stopRequested || this.#done || this.#child === null) return;
    const probation = this.#state.probation;
    // A deadline callback already queued before cancellation must not erase a rollback.
    if (probation === undefined || probation.rollbackReason !== undefined) return;
    const remaining = probation.deadline - this.#now();
    if (remaining <= 0) {
      await this.#finishProbation();
      return;
    }
    this.#probationTimer = setTimeout(
      () => this.#enqueue(() => this.#resumeProbation()),
      remaining,
    );
  }

  async #finishProbation(): Promise<void> {
    clearTimeout(this.#probationTimer);
    this.#probationTimer = undefined;
    const { probation, ...next } = this.#state;
    if (probation === undefined || probation.rollbackReason !== undefined) return;
    // The exit transition may still be queued behind a durable write at the deadline.
    if (this.#child?.exitedAt !== undefined && this.#child.exitedAt < probation.deadline) return;
    await this.#selectState(next);
    this.#snapshot = undefined;
  }

  async #handlePreparedTimeout(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "trial" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    await this.#returnToPrevious(pending, "rolled-back", "prepared-timeout", child);
  }

  async #handleExit(
    child: ManagedChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    this.#child = null;
    if (code === STATE_DIR_OWNED_EXIT_CODE) {
      const pending = this.#state.update;
      if (
        pending !== undefined &&
        (child.role === "trial" || this.#state.probation !== undefined)
      ) {
        // Exit 78 alone cannot tell us whether the owner was in the generation log.
        this.#snapshot = undefined;
        await markUntrackedDatabaseOwner(this.#baseDir, pending.id);
      }
      await this.#idleWhileRefused("state-dir-owned");
      return;
    }
    // A trial still owns a restorable snapshot. An active build must not roll
    // back to an even older runtime when the home already requires a newer one.
    if (child.role === "active" && code === DATABASE_AHEAD_EXIT_CODE) {
      await this.#idleWhileRefused("database-ahead");
      return;
    }
    if (this.#stopRequested || (await pathExists(stopMarkerPath(this.#baseDir)))) {
      this.#clearTimer();
      this.#done = true;
      this.#completion.resolve();
      return;
    }
    if (child.role === "trial") {
      this.#clearTimer();
      const pending = this.#state.update;
      if (pending?.status !== "pending") {
        throw new Error("Trial child exited without matching pending state.");
      }
      await this.#returnToPrevious(
        pending,
        "rolled-back",
        `candidate-exited:${String(code ?? signal ?? "unknown")}`,
      );
      return;
    }

    this.#clearTimer();
    const pending = this.#state.update;
    if (pending?.status === "pending") {
      await this.#startTrial(pending);
      return;
    }
    const probation = this.#state.probation;
    if (pending?.status === "committed" && probation !== undefined) {
      if ((child.exitedAt ?? this.#now()) < probation.deadline) {
        await this.#returnToPrevious(
          { ...pending, status: "pending", dbPath: probation.dbPath },
          "rolled-back",
          `probation-exit:${String(code ?? signal ?? "unknown")}`,
        );
        return;
      }
      await this.#finishProbation();
    }
    if (
      await this.#deferForDiskSpace(child.version, undefined, () =>
        this.#startChild(child.version, "active", this.#state.update),
      )
    )
      return;
    throw new Error(`Active child exited unexpectedly (${String(code ?? signal ?? "unknown")}).`);
  }

  // Exiting would make systemd or launchd start another refused server, so stay idle. A home
  // another server owns is probed until it frees; a database a newer build wrote fails a pending
  // update at once, without restoring over that build's writes.
  async #idleWhileRefused(reason: "state-dir-owned" | "database-ahead"): Promise<void> {
    this.#clearTimer();
    const pending = this.#state.update;
    if (pending?.status === "pending" && reason === "database-ahead") {
      if ((await databasePhase(this.#baseDir, pending.id)) !== "fresh") {
        throw databaseRecoveryRequired(
          this.#baseDir,
          pending,
          "The running version refused the database.",
        );
      }
      const next: ServiceState = {
        ...this.#state,
        activeVersion: pending.fromVersion,
        update: terminalUpdate({ pending, status: "failed", reason }),
      };
      await this.#selectState(next);
      await this.#repointServiceUnit(next.activeVersion);
    }
    if (pending?.status === "pending" && reason === "state-dir-owned") {
      this.#ownerBusySince ??= this.#now();
    }
    await this.#resumeProbation();
    this.#stateDirFreeProbes = 0;
    // The interval also keeps Node alive: signal listeners alone do not.
    if (reason === "state-dir-owned") this.#scheduleStateDirProbe();
    else this.#timer = setInterval(() => {}, 2_147_483_647);
    process.stderr.write(
      reason === "database-ahead"
        ? "[service-launcher] This GOAT build is older than the data in this GOAT home. Update GOAT or install a newer service, then restart this service.\n"
        : "[service-launcher] Another GOAT server owns this GOAT home. Stop it, then restart this service.\n",
    );
  }

  #scheduleStateDirProbe(): void {
    const timer = setTimeout(
      () =>
        this.#enqueue(async () => {
          if (this.#timer !== timer) return;
          await this.#reclaimStateDir();
          if (this.#timer === timer) this.#scheduleStateDirProbe();
        }),
      this.#stateDirOwnerPollMs,
    );
    this.#timer = timer;
  }

  async #reclaimStateDir(): Promise<void> {
    if (this.#stopRequested || this.#timer === undefined || this.#child !== null) return;
    const update = this.#state.update;
    const pending = update?.status === "pending" ? update : undefined;
    const owner = await stateDirOwner(
      pending === undefined ? NodePath.join(this.#baseDir, "userdata") : ownerLockDir(pending),
    );
    // A stop during the probe clears the timer.
    if (this.#timer === undefined) return;
    // A relaunching desktop app frees the home for a few seconds; leave it that gap.
    this.#stateDirFreeProbes = owner === undefined ? this.#stateDirFreeProbes + 1 : 0;
    if (owner !== undefined) {
      const since = this.#ownerBusySince;
      if (pending === undefined || since === undefined) return;
      const trialStarted = (await databasePhase(this.#baseDir, pending.id)) !== "fresh";
      if (trialStarted) this.#snapshot = undefined;
      if (this.#now() - since < STATE_DIR_OWNER_BOUND_MS) return;
      this.#ownerBusySince = undefined;
      const gaveUp =
        "[service-launcher] The GOAT home stayed owned by another server for 10 minutes; the update failed (db-owner-busy).\n";
      if (trialStarted) {
        throw databaseRecoveryRequired(
          this.#baseDir,
          pending,
          "Another owner was observed after the snapshot.",
        );
      }
      await this.#returnToPrevious(pending, "failed", "db-owner-busy");
      process.stderr.write(gaveUp);
      return;
    }
    if (this.#stateDirFreeProbes < 2) return;
    this.#clearTimer();
    this.#ownerBusySince = undefined;
    process.stderr.write("[service-launcher] The GOAT home is free again. Starting the server.\n");
    if (pending === undefined) {
      const probation = this.#state.probation;
      if (update?.status === "committed" && probation !== undefined) {
        throw databaseRecoveryRequired(
          this.#baseDir,
          { ...update, status: "pending", dbPath: probation.dbPath },
          "Another owner was observed during probation.",
        );
      }
      await this.#startChild(this.#state.activeVersion, "active", update);
      return;
    }
    if ((await databasePhase(this.#baseDir, pending.id)) !== "fresh") {
      await this.#returnToPrevious(pending, "failed", "state-dir-owned");
      return;
    }
    await this.#startTrial(pending);
  }

  async #returnToPrevious(
    pending: PendingServiceUpdate,
    status: "rolled-back" | "failed",
    reason: string,
    child?: ManagedChild,
  ): Promise<void> {
    this.#clearTimer();
    if (child !== undefined) {
      this.#child = null;
      await terminateChild(child.process);
    }
    // Recovery blocks without the in-process proof. The durable trial phase prevents relaunch.
    if (
      this.#snapshot?.updateId === pending.id &&
      (await databasePhase(this.#baseDir, pending.id)) === "trial" &&
      (await this.#deferForDiskSpace(pending.fromVersion, pending.dbPath, () =>
        this.#returnToPrevious(pending, status, reason),
      ))
    )
      return;
    const outcome = terminalUpdate({ pending, status, reason });
    const { probation, ...state } = this.#state;
    const next: ServiceState = { ...state, activeVersion: pending.fromVersion, update: outcome };
    const selection = await selectDatabaseRollback(
      this.#baseDir,
      pending,
      this.#snapshot,
      probation !== undefined,
      () => this.#selectState(next),
    );
    if (selection === "busy") {
      if (!this.#stopRequested) {
        this.#timer = setTimeout(
          () => this.#enqueue(() => this.#returnToPrevious(pending, status, reason)),
          Math.min(RESTORE_RETRY_MS, this.#stateDirOwnerPollMs),
        );
      }
      return;
    }
    this.#snapshot = undefined;
    try {
      await this.#startChild(next.activeVersion, "active", outcome);
    } finally {
      await this.#repointServiceUnit(next.activeVersion);
    }
  }
}

export async function main(): Promise<void> {
  // Units installed before the GOAT rename set only legacy names, and the retained server
  // versions this launcher starts may be older builds that read only those: carry both.
  Object.assign(process.env, withLegacyEnvNames(adoptLegacyEnv(process.env)));
  const baseDir = process.env.GOAT_HOME;
  if (baseDir === undefined || baseDir.trim() === "") {
    throw new Error("GOAT_HOME is required by the GOAT service launcher.");
  }
  const environment = await readServiceEnvironment(baseDir);
  const statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
  const contents = await NodeFSP.readFile(statePath, "utf8");
  const current = parseServiceState(contents);
  const state = current ?? parseLegacyServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  if (current === undefined && !(await runtimeExists(baseDir, state.activeVersion)))
    throw new Error(`Selected goat@${state.activeVersion} runtime is missing or incomplete.`);
  const serviceUnit = await serviceUnitFromEnvironment();
  await new Launcher(
    baseDir,
    state,
    serviceUnit === undefined ? { environment } : { environment, serviceUnit },
  ).run();
}
