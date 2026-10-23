import type { ServerUpdateState } from "@goat/client-runtime/state/server";
import type {
  DesktopSshEnvironmentTarget,
  DesktopUpdateChannel,
  EnvironmentId,
  OpenCodexUpdateStatus,
  ServerConfig,
} from "@goat/contracts";
import { cliReleaseChannelOf } from "@goat/shared/cliRelease";

import {
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";
import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";

export interface UpdateEverythingMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: {
    readonly environment: ServerConfig["environment"];
    readonly settings: Pick<ServerConfig["settings"], "continueThreadsAfterServerUpdate">;
  } | null;
  readonly connected: boolean;
  readonly hostedByThisApp: boolean;
  /** A saved SSH route owned by the desktop running this client. */
  readonly savedSshTarget: DesktopSshEnvironmentTarget | null;
  /** The session holds the scope a server update needs. */
  readonly canMaintain: boolean;
  readonly updateState: ServerUpdateState;
}

/** A GOAT runtime this desktop started over SSH; it moves to this app's server version. */
export interface SshRuntimeUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly fromVersion: string;
  readonly targetVersion: string;
}

export interface SkippedMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reason: string;
}

/**
 * Two kinds are in neither list: servers already on the target, and servers this app hosts,
 * which would relaunch the app mid-run and update with the app's own install anyway. A
 * desktop-managed server follows its own app's update feed, so the channel rule does not apply
 * to it.
 */
export function collectServerUpdateTargets(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  targetVersion: string,
  installsLocal = false,
): {
  readonly targets: ServerUpdateTarget[];
  readonly sshRuntimes: SshRuntimeUpdateTarget[];
  readonly skipped: SkippedMachine[];
} {
  const targets: ServerUpdateTarget[] = [];
  const sshRuntimes: SshRuntimeUpdateTarget[] = [];
  const skipped: SkippedMachine[] = [];
  for (const machine of machines) {
    const config = machine.serverConfig;
    if (machine.hostedByThisApp) continue;
    if (
      config !== null &&
      resolveVersionMismatch(config.environment.serverVersion, targetVersion) === null
    ) {
      continue;
    }
    const skip = (reason: string) =>
      skipped.push({ environmentId: machine.environmentId, label: machine.label, reason });
    if (config === null || !machine.connected) {
      skip("not connected");
      continue;
    }
    if (!machine.canMaintain) {
      skip("no permission");
      continue;
    }
    if (machine.updateState.status === "running") {
      skip("already updating");
      continue;
    }
    const selfUpdate = resolveServerSelfUpdateCapability(config);
    const desktopAppUpdate = supportsDesktopAppUpdate(config);
    if (selfUpdate === null) {
      if (machine.savedSshTarget === null) skip("needs a manual update");
      // The restarted app refreshes the runtimes it started, once each host is idle.
      else if (installsLocal) skip("updates with this app after it restarts");
      else
        sshRuntimes.push({
          environmentId: machine.environmentId,
          label: machine.label,
          target: machine.savedSshTarget,
          fromVersion: config.environment.serverVersion,
          targetVersion,
        });
      continue;
    }
    if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
      skip("needs a newer desktop app");
      continue;
    }
    const serverVersion = config.environment.serverVersion;
    if (
      selfUpdate !== "desktop-managed" &&
      cliReleaseChannelOf(serverVersion) !== cliReleaseChannelOf(targetVersion)
    ) {
      skip(`on the ${cliReleaseChannelOf(serverVersion)} channel`);
      continue;
    }
    targets.push({
      environmentId: machine.environmentId,
      serverLabel: machine.label,
      selfUpdate,
      installation: config.environment.capabilities.serverInstallation,
      desktopAppUpdate,
      threadContinuation: supportsServerUpdateThreadContinuation(config),
      continueThreadsAfterServerUpdate: config.settings.continueThreadsAfterServerUpdate ?? false,
      targetVersion,
    });
  }
  return { targets, sshRuntimes, skipped };
}

export type UpdateTab = "app" | "runtimes";

export type UpdateDialogRowKind = "server" | "ssh-runtime" | "local" | "providers" | "opencodex";

export interface UpdateDialogRow {
  /** Selection key, unique within its tab. */
  readonly id: string;
  readonly kind: UpdateDialogRowKind;
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  readonly detail: string;
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  /** Running threads the update waits for; it never interrupts them. */
  readonly runningThreads: number;
  /** False for a row that only reports state, such as an OpenCodex update that is not due. */
  readonly selectable: boolean;
}

export interface UpdateDialogTab {
  readonly rows: ReadonlyArray<UpdateDialogRow>;
  readonly skipped: ReadonlyArray<SkippedMachine>;
}

export interface LocalAppUpdate {
  readonly environmentId: EnvironmentId | null;
  readonly currentVersion: string;
  readonly version: string;
  readonly channel: DesktopUpdateChannel;
}

const CHANNEL_LABELS: Record<DesktopUpdateChannel, string> = {
  latest: "Stable",
  nightly: "Nightly",
};

function desktopChannelLabel(channel: DesktopUpdateChannel): string {
  return CHANNEL_LABELS[channel];
}

function serverDetail(server: ServerUpdateTarget): string {
  if (server.selfUpdate === "desktop-managed") return "Desktop app · installs its own channel";
  return "Background service";
}

/**
 * Remote machines first, this Mac last: its install relaunches the app, which would end the run
 * for everything after it.
 */
export function buildAppTab(input: {
  readonly local: LocalAppUpdate | null;
  readonly servers: ReadonlyArray<ServerUpdateTarget & { readonly fromVersion: string }>;
  readonly sshRuntimes: ReadonlyArray<SshRuntimeUpdateTarget>;
  readonly skipped: ReadonlyArray<SkippedMachine>;
  readonly runningThreads: (environmentId: EnvironmentId) => number;
}): UpdateDialogTab {
  const remote: UpdateDialogRow[] = [
    ...input.servers.map((server) => ({
      id: `server:${server.environmentId}`,
      kind: "server" as const,
      environmentId: server.environmentId,
      label: server.serverLabel,
      detail: serverDetail(server),
      fromVersion: server.fromVersion,
      toVersion: server.selfUpdate === "desktop-managed" ? null : server.targetVersion,
      runningThreads: input.runningThreads(server.environmentId),
      selectable: true,
    })),
    ...input.sshRuntimes.map((runtime) => ({
      id: `ssh-runtime:${runtime.environmentId}`,
      kind: "ssh-runtime" as const,
      environmentId: runtime.environmentId,
      label: runtime.label,
      detail: "SSH runtime",
      fromVersion: runtime.fromVersion,
      toVersion: runtime.targetVersion,
      runningThreads: input.runningThreads(runtime.environmentId),
      selectable: true,
    })),
  ];
  const local = input.local;
  return {
    rows: [
      ...remote,
      ...(local === null
        ? []
        : [
            {
              id: "local",
              kind: "local" as const,
              environmentId: local.environmentId,
              label: `GOAT on this Mac`,
              detail: `${desktopChannelLabel(local.channel)} channel · restarts last`,
              fromVersion: local.currentVersion,
              toVersion: local.version,
              runningThreads:
                local.environmentId === null ? 0 : input.runningThreads(local.environmentId),
              selectable: true,
            },
          ]),
    ],
    skipped: input.skipped,
  };
}

/** What the coordinator's last managed-update decision means to a person, or null to hide it. */
export function describeOpenCodexUpdate(
  status: OpenCodexUpdateStatus | null,
): { readonly detail: string; readonly due: boolean } | null {
  if (status === null) return null;
  const waitingOn = status.waitingOn.map((alias) => alias ?? "this Mac");
  switch (status.reason) {
    case "coordinated-by-home":
      return null;
    case "busy":
      return { detail: `Home first, then Children · waits for ${waitingOn.join(", ")}`, due: true };
    case "rollout-pending":
      return { detail: "Staged rollout has not reached this Hub yet", due: false };
    case "probation":
      return { detail: "Updated · watching health before accepting", due: false };
    case "rollback-incomplete":
      return { detail: "Restoring the previous version", due: false };
    case "admission-unsupported":
      return {
        detail: "A Child cannot pause new turns, so it waits for a release check",
        due: false,
      };
    default:
      return status.decision === "wait"
        ? { detail: "Home first, then Children", due: true }
        : { detail: "Updates automatically, Home first, then Children", due: false };
  }
}

export function buildRuntimesTab(input: {
  readonly providerMachines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly providers: ReadonlyArray<string>;
  }>;
  readonly opencodex: {
    readonly environmentId: EnvironmentId;
    readonly status: OpenCodexUpdateStatus | null;
    /** The host serves `server.checkOpenCodexUpdate`. */
    readonly canCheck: boolean;
  } | null;
}): UpdateDialogTab {
  const opencodex = input.opencodex;
  const described = opencodex === null ? null : describeOpenCodexUpdate(opencodex.status);
  return {
    rows: [
      ...input.providerMachines.map((machine) => ({
        id: `providers:${machine.environmentId}`,
        kind: "providers" as const,
        environmentId: machine.environmentId,
        label: machine.label,
        detail: machine.providers.join(", "),
        fromVersion: null,
        toVersion: null,
        runningThreads: 0,
        selectable: true,
      })),
      ...(opencodex === null || described === null
        ? []
        : [
            {
              id: "opencodex",
              kind: "opencodex" as const,
              environmentId: opencodex.environmentId,
              label: "OpenCodex",
              detail: described.detail,
              fromVersion: null,
              toVersion: opencodex.status?.targetVersion ?? null,
              runningThreads: 0,
              selectable: described.due && opencodex.canCheck,
            },
          ]),
    ],
    skipped: [],
  };
}

/** Rows that run when Update is pressed: selectable and not unchecked by the person. */
export function selectedRows(
  tab: UpdateDialogTab,
  unchecked: ReadonlySet<string>,
): ReadonlyArray<UpdateDialogRow> {
  return tab.rows.filter((row) => row.selectable && !unchecked.has(row.id));
}

export function updateButtonLabel(count: number): string {
  return count === 0 ? "Update" : `Update ${count}`;
}

/**
 * Starts `attempt` only once `idle` says the machine has no running turns, and again after a
 * busy refusal (the server can see work the client cannot, such as a scheduled task). Either wait
 * resolving false means the person stopped waiting; the result is then null.
 */
export async function runWhenIdle<A>(steps: {
  readonly idle: () => Promise<boolean>;
  readonly attempt: () => Promise<A>;
  readonly isBusy: (result: A) => boolean;
  readonly retryLater: () => Promise<boolean>;
}): Promise<A | null> {
  for (;;) {
    if (!(await steps.idle())) return null;
    const result = await steps.attempt();
    if (!steps.isBusy(result)) return result;
    if (!(await steps.retryLater())) return null;
  }
}

export type UpdateRunMachineStatus =
  | "providers"
  | "idle-wait"
  | "waiting"
  | "downloading"
  | "updating"
  | "restarting"
  | "done"
  | "failed";

export interface UpdateRunMachine {
  /** Unique within the run; the environment ID, or `opencodex:<id>` for its managed update. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly updatesProviders: boolean;
  readonly server: ServerUpdateTarget | null;
  readonly sshRuntime: SshRuntimeUpdateTarget | null;
  readonly opencodex: boolean;
  /** Holding until the machine has no running turns; a person can stop waiting. */
  readonly waitingForIdle: boolean;
  readonly handedOffVersion: string | null;
  readonly startedAt: number;
  readonly result: "done" | "failed" | null;
  readonly failure: string | null;
  readonly providerFailure: string | null;
}

export interface UpdateEverythingRun {
  readonly localVersion: string | null;
  /** `local-idle`: every remote machine is done or handed off; this Mac waits for its turns. */
  readonly phase: "providers" | "servers" | "local-idle" | "countdown" | "installing";
  readonly restartAt: number | null;
  /** Running turns on this Mac during `local-idle`. */
  readonly localRunningThreads?: number;
  readonly machines: ReadonlyArray<UpdateRunMachine>;
}

export function resolveUpdateRunMachineStatus(
  machine: UpdateRunMachine,
  phase: UpdateEverythingRun["phase"],
  serverState: ServerUpdateState,
): UpdateRunMachineStatus {
  if (machine.result !== null) return machine.result;
  if (machine.waitingForIdle) return "idle-wait";
  if (machine.handedOffVersion !== null) return "restarting";
  if (phase === "providers" && machine.updatesProviders) return "providers";
  if (machine.sshRuntime !== null || machine.opencodex) return "updating";
  if (machine.server !== null && serverState.status === "running") {
    return serverState.stage === "resuming" ? "restarting" : "downloading";
  }
  return "waiting";
}

export function isServerUpdateHandedOff(state: ServerUpdateState): boolean {
  return state.status === "running" && state.stage === "resuming";
}

export function closeFinishedUpdateRun(run: UpdateEverythingRun): UpdateEverythingRun | null {
  return run.phase === "servers" &&
    run.localVersion === null &&
    run.machines.every((machine) => machine.result === "done")
    ? null
    : run;
}

const UPDATE_SLOW_AFTER_MS = 3 * 60 * 1000;

export function formatUpdateElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface UpdateRunMachineView {
  readonly machine: UpdateRunMachine;
  readonly status: UpdateRunMachineStatus;
}

export type UpdateRunLocalState =
  | { readonly status: "downloading"; readonly percent: number | null }
  | { readonly status: "waiting" }
  | null;

export interface UpdateCapsuleView {
  readonly tone: "default" | "slow" | "failed";
  readonly label: string;
  readonly slow?: { readonly status: string; readonly elapsed: string };
  readonly action: "later" | "retry" | "dismiss" | "restart-now" | "stop-waiting" | null;
}

const isActive = (status: UpdateRunMachineStatus) => status !== "done" && status !== "failed";
/** Waiting machines are not slow: they wait on purpose, for a server-side or idle turn. */
const isWorking = (status: UpdateRunMachineStatus) =>
  isActive(status) && status !== "waiting" && status !== "idle-wait";

function threadCount(count: number): string {
  return `${count} running ${count === 1 ? "thread" : "threads"}`;
}

export function describeUpdateCapsule(
  run: UpdateEverythingRun,
  machines: ReadonlyArray<UpdateRunMachineView>,
  local: UpdateRunLocalState,
  now: number,
): UpdateCapsuleView {
  if (run.phase === "countdown" && run.restartAt !== null) {
    const seconds = Math.max(0, Math.ceil((run.restartAt - now) / 1000));
    return { tone: "default", label: `Restart in ${seconds}s`, action: "later" };
  }
  if (run.phase === "installing") {
    return { tone: "default", label: "Restarting…", action: null };
  }
  if (run.phase === "local-idle") {
    return {
      tone: "default",
      label: `Restart waits for ${threadCount(run.localRunningThreads ?? 0)}`,
      action: "restart-now",
    };
  }
  const active = machines.filter(({ status }) => isWorking(status));
  const slowest = active.toSorted((a, b) => a.machine.startedAt - b.machine.startedAt)[0];
  if (slowest && now - slowest.machine.startedAt >= UPDATE_SLOW_AFTER_MS) {
    return {
      tone: "slow",
      label: slowest.machine.label,
      slow: {
        status: RUN_STATUS_LABELS[slowest.status],
        elapsed: formatUpdateElapsed(now - slowest.machine.startedAt),
      },
      action: null,
    };
  }
  const done = machines.filter(({ status }) => status === "done").length;
  const idleWaiting = machines.filter(({ status }) => status === "idle-wait");
  if (idleWaiting.length > 0 && active.length === 0) {
    return {
      tone: "default",
      label:
        idleWaiting.length === 1
          ? `${idleWaiting[0]!.machine.label} waits for idle`
          : `${idleWaiting.length} wait for idle`,
      action: "stop-waiting",
    };
  }
  if (machines.some(({ status }) => isActive(status))) {
    return { tone: "default", label: `${done} of ${machines.length} updated`, action: null };
  }
  if (local?.status === "downloading") {
    return {
      tone: "default",
      label: `Downloading${local.percent === null ? "" : ` ${Math.floor(local.percent)}%`}`,
      action: null,
    };
  }
  const failed = machines.filter(({ status }) => status === "failed");
  if (failed.length > 0) {
    return {
      tone: "failed",
      label: failed.length === 1 ? `${failed[0]!.machine.label} failed` : `${failed.length} failed`,
      action: failed.some(({ machine }) => machine.server !== null || machine.sshRuntime !== null)
        ? "retry"
        : "dismiss",
    };
  }
  return { tone: "default", label: `${done} of ${machines.length} updated`, action: null };
}

export const RUN_STATUS_LABELS: Record<UpdateRunMachineStatus, string> = {
  providers: "updating providers",
  "idle-wait": "waiting for idle",
  waiting: "waiting",
  downloading: "downloading",
  updating: "updating",
  restarting: "restarting",
  done: "done",
  failed: "failed",
};

export interface UpdateEverythingResult {
  readonly localVersion: string | null;
  readonly updatedServers: number;
  readonly updatedProviders: number;
  readonly failures: ReadonlyArray<string>;
  readonly restarting: ReadonlyArray<string>;
  /** Plain sentences for the toast, such as an OpenCodex update waiting for idle. */
  readonly notes?: ReadonlyArray<string>;
}

export function collectUpdateEverythingResult(input: {
  readonly localVersion: string | null;
  readonly localFailures: ReadonlyArray<string>;
  readonly servers: ReadonlyArray<{
    readonly label: string;
    readonly outcome: ServerUpdateOutcome;
  }>;
  readonly providers: ReadonlyArray<
    | { readonly status: "interrupted" | "updated" }
    | { readonly status: "failed"; readonly line: string }
  >;
}): UpdateEverythingResult {
  return {
    localVersion: input.localVersion,
    updatedServers: input.servers.filter(({ outcome }) => outcome.status === "updated").length,
    updatedProviders: input.providers.filter((outcome) => outcome.status === "updated").length,
    restarting: [],
    failures: [
      ...input.localFailures.map((failure) => `This app: ${failure}`),
      ...input.servers.flatMap(({ label, outcome }) =>
        outcome.status === "failed" ? [`${label}: ${outcome.message}`] : [],
      ),
      ...input.providers.flatMap((outcome) => (outcome.status === "failed" ? [outcome.line] : [])),
    ],
  };
}

export function getUpdateEverythingToastView(
  result: UpdateEverythingResult,
  appVersion: string,
): {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
} | null {
  const parts = [
    result.localVersion !== null && result.localVersion === appVersion ? "this app" : null,
    countLabel(result.updatedServers, "server"),
    countLabel(result.updatedProviders, "provider"),
  ].filter((part) => part !== null);
  const restarting = [
    ...(result.restarting.length === 0
      ? []
      : [
          `${joinList(result.restarting)} ${result.restarting.length === 1 ? "is" : "are"} still restarting.`,
        ]),
    ...(result.notes ?? []),
  ];
  if (result.failures.length === 0) {
    if (parts.length === 0 && restarting.length === 0) return null;
    return {
      type: "success",
      title: parts.length === 0 ? "Update checked" : `Updated ${joinList(parts)}`,
      ...(restarting.length === 0 ? {} : { description: restarting.join("\n") }),
    };
  }
  return {
    type: "error",
    title: parts.length === 0 ? "Update failed" : `Updated ${joinList(parts)}`,
    description: [...result.failures, ...restarting].join("\n"),
  };
}

function countLabel(count: number, noun: string): string | null {
  return count === 0 ? null : `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function joinList(parts: ReadonlyArray<string>): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/** The tooltip line and dialog title: what each tab would update. */
export function describeUpdateTabs(counts: {
  readonly app: number;
  readonly runtimes: number;
}): string {
  const parts = [
    counts.app === 0 ? null : `App & servers: ${counts.app}`,
    counts.runtimes === 0 ? null : `Runtimes: ${counts.runtimes}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Everything is up to date" : parts.join(" · ");
}
