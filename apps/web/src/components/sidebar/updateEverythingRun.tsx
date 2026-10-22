import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { APP_VERSION } from "~/branding";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { serverEnvironment } from "~/state/server";
import { environmentThreadShells } from "~/state/threads";
import { resolveVersionMismatch } from "~/versionSkew";
import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  closeFinishedUpdateRun,
  getUpdateEverythingToastView,
  isServerUpdateHandedOff,
  type SshRuntimeUpdateTarget,
  type UpdateEverythingResult,
  type UpdateEverythingRun,
  type UpdateRunMachine,
} from "./updateEverything.logic";

const updateEverythingRunAtom = Atom.make<UpdateEverythingRun | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("update-everything-run"),
);

export function useUpdateEverythingRun(): UpdateEverythingRun | null {
  return useAtomValue(updateEverythingRunAtom);
}

export function setUpdateEverythingRun(
  update: (run: UpdateEverythingRun | null) => UpdateEverythingRun | null,
): void {
  appAtomRegistry.update(updateEverythingRunAtom, update);
}

const isRunningThread = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";

/** Turns running on one machine; updates wait for this to reach zero instead of interrupting. */
export const runningThreadCountAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentThreadShells.environmentThreadsAtom(environmentId)).filter((thread) =>
        isRunningThread(thread.status),
      ).length,
  ).pipe(Atom.withLabel(`update-everything-running-threads:${environmentId}`)),
);

export function useRunningThreadCounts(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<EnvironmentId, number> {
  return useAtomValue(runningThreadCountsAtom(environmentIdsKey(environmentIds)));
}

const runningThreadCountsAtom = Atom.family((key: string) =>
  Atom.make(
    (get) =>
      new Map(
        key
          .split("\n")
          .filter((id) => id !== "")
          .map((id) => {
            const environmentId = EnvironmentId.make(id);
            return [environmentId, get(runningThreadCountAtom(environmentId))] as const;
          }),
      ),
  ).pipe(Atom.withLabel(`update-everything-running-thread-counts:${key}`)),
);

/** Pending waits a person can end from the capsule; each resolves false when stopped. */
const stopWaits = new Set<() => void>();

export function stopWaitingUpdateRunMachines(): void {
  // Each stop removes itself; a Set visits the rest regardless.
  for (const stop of stopWaits) stop();
}

function setWaitingForIdle(key: string, waitingForIdle: boolean): void {
  setUpdateEverythingRun(
    (run) =>
      run && {
        ...run,
        machines: run.machines.map((machine) =>
          machine.key === key && machine.waitingForIdle !== waitingForIdle
            ? { ...machine, waitingForIdle }
            : machine,
        ),
      },
  );
}

function stoppableWait(key: string, start: (finish: (idle: boolean) => void) => () => void) {
  return new Promise<boolean>((resolve) => {
    let done = false;
    let cleanup = () => {};
    const finish = (idle: boolean) => {
      if (done) return;
      done = true;
      stopWaits.delete(stop);
      queueMicrotask(() => cleanup());
      setWaitingForIdle(key, false);
      resolve(idle);
    };
    const stop = () => finish(false);
    stopWaits.add(stop);
    cleanup = start(finish);
  });
}

/** Resolves true once the machine has no running turns, false when a person stops waiting. */
export function waitForIdleMachine(key: string, environmentId: EnvironmentId): Promise<boolean> {
  return stoppableWait(key, (finish) =>
    appAtomRegistry.subscribe(
      runningThreadCountAtom(environmentId),
      (count) => {
        if (count === 0) finish(true);
        else setWaitingForIdle(key, true);
      },
      { immediate: true },
    ),
  );
}

/** The server refused because it saw work; ask again after a while, or when stopped give up. */
export function waitToRetryBusyMachine(key: string, delayMs: number): Promise<boolean> {
  return stoppableWait(key, (finish) => {
    setWaitingForIdle(key, true);
    const timer = setTimeout(() => finish(true), delayMs);
    return () => clearTimeout(timer);
  });
}

let restartNow: (() => void) | null = null;

/** This Mac restarts last and never under running turns, unless a person chooses Restart now. */
export function waitForLocalIdle(environmentId: EnvironmentId | null): Promise<void> {
  if (environmentId === null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      restartNow = null;
      queueMicrotask(() => unsubscribe());
      resolve();
    };
    restartNow = finish;
    const unsubscribe = appAtomRegistry.subscribe(
      runningThreadCountAtom(environmentId),
      (count) => {
        if (count === 0) return finish();
        setUpdateEverythingRun(
          (run) => run && { ...run, phase: "local-idle", localRunningThreads: count },
        );
      },
      { immediate: true },
    );
  });
}

export function restartUpdateNow(): void {
  restartNow?.();
}

function updateRunMachines(update: (machine: UpdateRunMachine) => UpdateRunMachine): void {
  setUpdateEverythingRun(
    (run) => run && closeFinishedUpdateRun({ ...run, machines: run.machines.map(update) }),
  );
}

export function settleUpdateRunMachine(
  key: string,
  failure: string | null,
  {
    serverUpdated = false,
    providerFailure,
  }: { readonly serverUpdated?: boolean; readonly providerFailure?: string | null } = {},
): void {
  updateRunMachines((machine) =>
    machine.key === key
      ? {
          ...machine,
          result: failure === null ? "done" : "failed",
          failure,
          waitingForIdle: false,
          ...(serverUpdated ? { server: null, sshRuntime: null } : {}),
          ...(providerFailure === undefined ? {} : { providerFailure }),
        }
      : machine,
  );
}

export function retryFailedUpdateRunServers(
  update: (
    target: ServerUpdateTarget,
    options: { readonly quiet: boolean; readonly whenIdle: boolean },
  ) => Promise<ServerUpdateOutcome>,
  updateSshRuntime: (target: SshRuntimeUpdateTarget) => Promise<ServerUpdateOutcome>,
): void {
  const failed = (appAtomRegistry.get(updateEverythingRunAtom)?.machines ?? []).flatMap(
    (machine) =>
      machine.result === "failed" && (machine.server !== null || machine.sshRuntime !== null)
        ? [machine]
        : [],
  );
  const retried = new Set(failed.map((machine) => machine.key));
  const startedAt = Date.now();
  updateRunMachines((machine) =>
    retried.has(machine.key) ? { ...machine, result: null, failure: null, startedAt } : machine,
  );
  for (const machine of failed) {
    // Retry keeps the run's promise: a busy machine refuses again instead of losing its turns.
    const attempt =
      machine.server !== null
        ? update(machine.server, { quiet: true, whenIdle: true })
        : updateSshRuntime(machine.sshRuntime!);
    void attempt.then((outcome) =>
      settleUpdateRunMachine(
        machine.key,
        outcome.status === "updated"
          ? machine.providerFailure
          : outcome.status === "failed"
            ? outcome.message
            : "Could not start the update",
        { serverUpdated: outcome.status === "updated" },
      ),
    );
  }
}

export function dismissSettledUpdateRunMachines(): void {
  setUpdateEverythingRun(
    (run) =>
      run &&
      closeFinishedUpdateRun({
        ...run,
        machines: run.machines.filter((machine) => machine.result === null),
      }),
  );
}

export function waitForServerUpdateHandoff(
  environmentId: EnvironmentId,
  finished: Promise<unknown>,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      queueMicrotask(() => unsubscribe());
      resolve();
    };
    const unsubscribe = appAtomRegistry.subscribe(
      serverEnvironment.updateStateAtom(environmentId),
      (state) => {
        if (isServerUpdateHandedOff(state)) finish();
      },
      { immediate: true },
    );
    void finished.then(finish, finish);
  });
}

let decideRestart: ((restart: boolean) => void) | null = null;

export function waitForUpdateRestart(delayMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const decide = (restart: boolean) => {
      clearTimeout(timer);
      decideRestart = null;
      resolve(restart);
    };
    const timer = setTimeout(() => decide(true), delayMs);
    decideRestart = decide;
    setUpdateEverythingRun(
      (run) => run && { ...run, phase: "countdown", restartAt: Date.now() + delayMs },
    );
  });
}

export function postponeUpdateRestart(): void {
  decideRestart?.(false);
}

const SAVED_RESULT_KEY = "goat:update-everything-result:v1";
const SAVED_RESULT_MAX_AGE_MS = 10 * 60 * 1000;
// Covers a background service's 30-minute trial start, like the server update itself.
const HANDOFF_TIMEOUT_MS = 32 * 60 * 1000;

const HandedOffServer = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  targetVersion: Schema.String,
  startedAt: Schema.Number,
});
type HandedOffServer = typeof HandedOffServer.Type;

const SavedResult = Schema.Struct({
  savedAt: Schema.Number,
  localVersion: Schema.NullOr(Schema.String),
  updatedServers: Schema.Number,
  updatedProviders: Schema.Number,
  failures: Schema.Array(Schema.String),
  handedOff: Schema.optional(Schema.Array(HandedOffServer)),
});
const decodeSavedResult = Schema.decodeUnknownOption(Schema.fromJsonString(SavedResult));

export function saveUpdateEverythingResult(result: UpdateEverythingResult): void {
  const run = appAtomRegistry.get(updateEverythingRunAtom);
  const handedOff = (run?.machines ?? []).flatMap((machine): HandedOffServer[] => {
    if (machine.result !== null) return [];
    const state = appAtomRegistry.get(serverEnvironment.updateStateAtom(machine.environmentId));
    // A desktop-managed server installs its own feed's version, which only its
    // update state knows.
    const targetVersion =
      machine.handedOffVersion ??
      (state.status === "running" ? state.targetVersion : machine.server?.targetVersion);
    if (targetVersion === undefined) return [];
    return [
      {
        environmentId: machine.environmentId,
        label: machine.label,
        targetVersion,
        startedAt: machine.startedAt,
      },
    ];
  });
  try {
    window.localStorage.setItem(
      SAVED_RESULT_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        localVersion: result.localVersion,
        updatedServers: result.updatedServers,
        updatedProviders: result.updatedProviders,
        failures: result.failures,
        handedOff,
      } satisfies typeof SavedResult.Type),
    );
  } catch {}
}

export function clearSavedUpdateEverythingResult(): void {
  try {
    window.localStorage.removeItem(SAVED_RESULT_KEY);
  } catch {}
}

function takeSavedUpdateEverythingResult(): typeof SavedResult.Type | null {
  try {
    const raw = window.localStorage.getItem(SAVED_RESULT_KEY);
    if (raw === null) return null;
    window.localStorage.removeItem(SAVED_RESULT_KEY);
    return Option.getOrNull(
      Option.filter(
        decodeSavedResult(raw),
        (saved) => Date.now() - saved.savedAt < SAVED_RESULT_MAX_AGE_MS,
      ),
    );
  } catch {
    return null;
  }
}

export function showUpdateEverythingResult(result: UpdateEverythingResult): void {
  const view = getUpdateEverythingToastView(result, APP_VERSION);
  if (!view) return;
  toastManager.add(
    stackedThreadToast({
      type: view.type,
      title: view.title,
      ...(view.description
        ? { description: <span className="whitespace-pre-line">{view.description}</span> }
        : {}),
    }),
  );
}

function followHandedOffServers(servers: ReadonlyArray<HandedOffServer>): void {
  if (servers.length === 0) return;
  setUpdateEverythingRun(() => ({
    localVersion: null,
    phase: "servers",
    restartAt: null,
    machines: servers.map((server) => ({
      key: server.environmentId,
      environmentId: server.environmentId,
      label: server.label,
      updatesProviders: false,
      server: null,
      sshRuntime: null,
      opencodex: false,
      waitingForIdle: false,
      handedOffVersion: server.targetVersion,
      startedAt: server.startedAt,
      result: null,
      failure: null,
      providerFailure: null,
    })),
  }));
  let remaining = servers.length;
  let updatedServers = 0;
  const failures: string[] = [];
  for (const server of servers) {
    let settled = false;
    const settle = (failure: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe());
      settleUpdateRunMachine(server.environmentId, failure);
      if (failure === null) updatedServers += 1;
      else failures.push(`${server.label}: ${failure}`);
      remaining -= 1;
      if (remaining === 0) {
        showUpdateEverythingResult({
          localVersion: null,
          updatedServers,
          updatedProviders: 0,
          failures,
          restarting: [],
        });
      }
    };
    const timer = setTimeout(
      () => settle(`Not back after ${HANDOFF_TIMEOUT_MS / 60_000} minutes`),
      server.startedAt + HANDOFF_TIMEOUT_MS - Date.now(),
    );
    const unsubscribe = appAtomRegistry.subscribe(
      serverEnvironment.configValueAtom(server.environmentId),
      (config) => {
        if (
          config !== null &&
          resolveVersionMismatch(config.environment.serverVersion, server.targetVersion) === null
        ) {
          settle(null);
        }
      },
      { immediate: true },
    );
  }
}

let notifiedNotAppliedVersion: string | null = null;

export function DesktopUpdateLaunchNotice() {
  const notAppliedVersion = useDesktopUpdateState()?.notAppliedVersion ?? null;

  useEffect(() => {
    const saved = takeSavedUpdateEverythingResult();
    if (!saved) return;
    const handedOff = saved.handedOff ?? [];
    showUpdateEverythingResult({ ...saved, restarting: handedOff.map((server) => server.label) });
    followHandedOffServers(handedOff);
  }, []);

  useEffect(() => {
    if (notAppliedVersion === null || notifiedNotAppliedVersion === notAppliedVersion) return;
    notifiedNotAppliedVersion = notAppliedVersion;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Update did not apply",
        description: `GOAT is still on ${APP_VERSION}. Install ${notAppliedVersion} again from the update button.`,
      }),
    );
  }, [notAppliedVersion]);

  return null;
}
