import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  type DesktopUpdateChannel,
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  SERVER_UPDATE_BUSY_REASON,
} from "@goat/contracts";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments } from "~/state/environments";
import { useCliReleasePublished } from "~/state/npmRelease";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom, serverEnvironment } from "~/state/server";
import { environmentSessionStatesAtom } from "~/state/session";
import { sshRuntime } from "~/state/sshRuntime";
import { savedConnectionSshRoute } from "../settings/ConnectionsSettings.logic";
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";
import { useCheckForUpdateWhenHostIsNewer } from "./newerHostUpdateCheck";
import { useProviderUpdates } from "../ProviderUpdatesAction";
import {
  canUpdateServer,
  type ServerUpdateOutcome,
  type ServerUpdateTarget,
  useServerUpdate,
} from "../ServerUpdateAction";
import {
  buildAppTab,
  closeFinishedUpdateRun,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  runWhenIdle,
  type SkippedMachine,
  type SshRuntimeUpdateTarget,
  type UpdateDialogRow,
  type UpdateRunMachine,
} from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  settleUpdateRunMachine,
  showUpdateEverythingResult,
  useRunningThreadCounts,
  waitForIdleMachine,
  waitForLocalIdle,
  waitForServerUpdateHandoff,
  waitForUpdateRestart,
  waitToRetryBusyMachine,
} from "./updateEverythingRun";

const UPDATE_RESTART_DELAY_MS = 5_000;
/** The server can see work the client cannot (a scheduled task); ask it again this often. */
const BUSY_RETRY_MS = 60_000;
/** An SSH runtime update waiting on its host is read again this often, as Settings does. */
const SSH_RUNTIME_POLL_MS = 10_000;

export type ReportLocalUpdateError = (title: string, description: string) => void;

export interface LocalUpdateActions {
  readonly downloadLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
  readonly installLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
}

const isBusyRefusal = (outcome: ServerUpdateOutcome) =>
  outcome.status === "failed" && outcome.message.includes(SERVER_UPDATE_BUSY_REASON);

function runMachine(
  base: Pick<UpdateRunMachine, "key" | "environmentId" | "label"> & Partial<UpdateRunMachine>,
  startedAt: number,
): UpdateRunMachine {
  return {
    updatesProviders: false,
    server: null,
    sshRuntime: null,
    opencodex: false,
    waitingForIdle: false,
    handedOffVersion: null,
    result: null,
    failure: null,
    providerFailure: null,
    ...base,
    startedAt,
  };
}

/** Asks the desktop to move one SSH runtime when its host is idle, then follows it to the end. */
export async function updateSshRuntimeWhenIdle(
  runtime: SshRuntimeUpdateTarget,
): Promise<ServerUpdateOutcome> {
  const input = { environmentId: runtime.environmentId, target: runtime.target };
  let result = await sshRuntime.update.run(appAtomRegistry, { ...input, mode: "when_idle" });
  for (;;) {
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      return {
        status: "failed",
        message: error instanceof Error ? error.message : "Could not update the runtime.",
      };
    }
    const value = result.value;
    if (value === null) return { status: "skipped" };
    if (value.kind === "error") return { status: "failed", message: value.message };
    const status = value.status;
    if (status?.state === "failed") {
      return { status: "failed", message: status.failure?.reason ?? "The runtime update failed." };
    }
    if (status?.state === "ready" && status.runtimeVersion === status.requestedVersion) {
      return { status: "updated" };
    }
    if (status?.state === "ready" || status?.state === "update_blocked") {
      return {
        status: "failed",
        message:
          status.state === "update_blocked"
            ? "Another GOAT server is running on that host."
            : `Still on ${status.runtimeVersion ?? "an older runtime"}`,
      };
    }
    // `update_waiting` and `preparing`: the host waits for idle or is mid-install.
    const waiting = status?.state === "update_waiting";
    const key = runtime.environmentId;
    const keepGoing = waiting
      ? await waitToRetryBusyMachine(key, SSH_RUNTIME_POLL_MS)
      : await new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1_000));
    if (!keepGoing) {
      return {
        status: "failed",
        message: "Stopped waiting. The host still updates once it is idle.",
      };
    }
    result = await sshRuntime.refresh.run(appAtomRegistry, input);
  }
}

export function useUpdateEverything(
  localUpdateVersion: string | null,
  localChannel: DesktopUpdateChannel | null,
) {
  const targetVersion = localUpdateVersion ?? APP_VERSION;
  const { environments } = useEnvironments();
  const environmentIds = environments.map(({ environmentId }) => environmentId);
  const idsKey = environmentIdsKey(environmentIds);
  const sessionStates = useAtomValue(environmentSessionStatesAtom(idsKey));
  const updateStates = useAtomValue(environmentUpdateStatesAtom(idsKey));
  const runningThreads = useRunningThreadCounts(environmentIds);
  const machines = environments.map((environment, index) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverConfig: environment.serverConfig,
    connected: environment.connection.phase === "connected",
    savedSshTarget: isElectron ? (savedConnectionSshRoute(environment)?.target ?? null) : null,
    hostedByThisApp:
      isElectron &&
      (environment.entry.target._tag === "PrimaryConnectionTarget" ||
        isDesktopLocalConnectionTarget(environment.entry.target)),
    canMaintain: canUpdateServer(sessionStates[index]!),
    updateState: updateStates[index]!,
  }));
  const localEnvironmentId =
    machines.find((machine) => machine.hostedByThisApp && machine.connected)?.environmentId ?? null;
  useCheckForUpdateWhenHostIsNewer(
    machines.map((machine) =>
      machine.connected && !machine.hostedByThisApp
        ? machine.serverConfig?.environment.serverVersion
        : null,
    ),
  );
  const {
    targets: behindServers,
    sshRuntimes,
    skipped: unreachable,
  } = collectServerUpdateTargets(machines, targetVersion, localUpdateVersion !== null);
  // A desktop-managed server installs from its own app's update feed, so only
  // other servers need the verified CLI archives in GOAT's release repository.
  const needsCli = behindServers.some((server) => server.selfUpdate !== "desktop-managed");
  const published = useCliReleasePublished(needsCli ? targetVersion : null);
  const servers = published
    ? behindServers
    : behindServers.filter((server) => server.selfUpdate === "desktop-managed");
  const skipped: ReadonlyArray<SkippedMachine> = [
    ...unreachable,
    ...behindServers
      .filter((server) => !servers.includes(server))
      .map((server) => ({
        environmentId: server.environmentId,
        label: server.serverLabel,
        reason: `GOAT ${targetVersion} CLI release assets are not available yet`,
      })),
  ];
  const providers = useProviderUpdates();
  const updateServer = useServerUpdate();
  const checkOpenCodexUpdate = serverEnvironment.checkOpenCodexUpdate;

  const versionOf = (environmentId: EnvironmentId) =>
    machines.find((machine) => machine.environmentId === environmentId)?.serverConfig?.environment
      .serverVersion ?? "";
  const appTab = buildAppTab({
    local:
      localUpdateVersion === null || localChannel === null
        ? null
        : {
            environmentId: localEnvironmentId,
            currentVersion: APP_VERSION,
            version: localUpdateVersion,
            channel: localChannel,
          },
    servers: servers.map((server) => ({ ...server, fromVersion: versionOf(server.environmentId) })),
    sshRuntimes,
    skipped,
    runningThreads: (environmentId) => runningThreads.get(environmentId) ?? 0,
  });
  const providerMachines = providers.machines.map((machine) => ({
    environmentId: machine.environmentId,
    label: machine.label,
    providers: machine.candidates.map(
      (candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
    ),
  }));
  const remoteCount = servers.length + sshRuntimes.length;

  const runApp = async (rows: ReadonlyArray<UpdateDialogRow>, local: LocalUpdateActions) => {
    const localFailures: Array<string> = [];
    const reportLocalError: ReportLocalUpdateError = (title, description) => {
      localFailures.push(`${title}: ${description}`);
    };
    const ids = new Set(rows.map((row) => row.id));
    const chosenServers = servers.filter((server) => ids.has(`server:${server.environmentId}`));
    const chosenRuntimes = sshRuntimes.filter((runtime) =>
      ids.has(`ssh-runtime:${runtime.environmentId}`),
    );
    const includesLocal = ids.has("local");
    const startedAt = Date.now();
    const localVersion = includesLocal && local.installLocal ? localUpdateVersion : null;
    setUpdateEverythingRun(() => ({
      localVersion,
      phase: "servers",
      restartAt: null,
      machines: [
        ...chosenServers.map((server) =>
          runMachine(
            {
              key: server.environmentId,
              environmentId: server.environmentId,
              label: server.serverLabel,
              server,
            },
            startedAt,
          ),
        ),
        ...chosenRuntimes.map((runtime) =>
          runMachine(
            {
              key: runtime.environmentId,
              environmentId: runtime.environmentId,
              label: runtime.label,
              sshRuntime: runtime,
            },
            startedAt,
          ),
        ),
      ],
    }));
    const finished: Array<{ label: string; outcome: ServerUpdateOutcome }> = [];
    const settle = (key: string, label: string, outcome: ServerUpdateOutcome | null) => {
      const result = outcome ?? {
        status: "failed" as const,
        message: "Stopped waiting for idle",
      };
      settleUpdateRunMachine(
        key,
        result.status === "failed"
          ? result.message
          : result.status === "skipped"
            ? "Could not start the update"
            : null,
        { serverUpdated: result.status === "updated" },
      );
      finished.push({ label, outcome: result });
    };
    try {
      const downloaded =
        includesLocal && local.downloadLocal
          ? local.downloadLocal(reportLocalError)
          : Promise.resolve(true);
      const remote = Promise.all([
        ...chosenServers.map(async (server) => {
          const key = server.environmentId;
          const outcome = runWhenIdle({
            idle: () => waitForIdleMachine(key, server.environmentId),
            attempt: () => updateServer(server, { quiet: true, whenIdle: true }),
            isBusy: isBusyRefusal,
            retryLater: () => waitToRetryBusyMachine(key, BUSY_RETRY_MS),
          }).then((result) => {
            settle(key, server.serverLabel, result);
            return result;
          });
          // This Mac waits only for each server to start its own restart, not to come back.
          await waitForServerUpdateHandoff(server.environmentId, outcome);
        }),
        ...chosenRuntimes.map(async (runtime) => {
          settle(runtime.environmentId, runtime.label, await updateSshRuntimeWhenIdle(runtime));
        }),
      ]);
      const [localReady] = await Promise.all([downloaded, remote]);
      const result = () =>
        collectUpdateEverythingResult({
          localVersion: null,
          localFailures,
          servers: finished,
          providers: [],
        });
      if (includesLocal && localReady && local.installLocal) {
        await waitForLocalIdle(localEnvironmentId);
        if (await waitForUpdateRestart(UPDATE_RESTART_DELAY_MS)) {
          setUpdateEverythingRun((run) => run && { ...run, phase: "installing", restartAt: null });
          saveUpdateEverythingResult({ ...result(), localVersion });
          if (await local.installLocal(reportLocalError)) return;
          clearSavedUpdateEverythingResult();
        }
      }
      setUpdateEverythingRun(
        (run) =>
          run &&
          closeFinishedUpdateRun({ ...run, phase: "servers", restartAt: null, localVersion: null }),
      );
      showUpdateEverythingResult(result());
    } catch (error) {
      setUpdateEverythingRun(() => null);
      throw error;
    }
  };

  const runRuntimes = async (
    rows: ReadonlyArray<UpdateDialogRow>,
    opencodexEnvironmentId: EnvironmentId | null,
  ) => {
    const ids = new Set(rows.map((row) => row.id));
    const providerIds = new Set<string>(
      providers.machines
        .filter((machine) => ids.has(`providers:${machine.environmentId}`))
        .map((machine) => machine.environmentId),
    );
    const opencodex = ids.has("opencodex") ? opencodexEnvironmentId : null;
    const startedAt = Date.now();
    setUpdateEverythingRun(() => ({
      localVersion: null,
      phase: "providers",
      restartAt: null,
      machines: [
        ...providers.machines
          .filter((machine) => providerIds.has(machine.environmentId))
          .map((machine) =>
            runMachine(
              {
                key: machine.environmentId,
                environmentId: machine.environmentId,
                label: machine.label,
                updatesProviders: true,
              },
              startedAt,
            ),
          ),
        ...(opencodex === null
          ? []
          : [
              runMachine(
                {
                  key: `opencodex:${opencodex}`,
                  environmentId: opencodex,
                  label: "OpenCodex",
                  opencodex: true,
                },
                startedAt,
              ),
            ]),
      ],
    }));
    try {
      const runs =
        providerIds.size === 0 ? [] : await providers.updateAll({ quiet: true, only: providerIds });
      const outcomes = runs.map(getProviderUpdateRunOutcome);
      for (const environmentId of providerIds) {
        const failure = runs.flatMap((run, index) => {
          const outcome = outcomes[index]!;
          if (run.environmentId !== environmentId || outcome.status === "updated") return [];
          return [outcome.status === "failed" ? outcome.line : "Provider update interrupted"];
        })[0];
        settleUpdateRunMachine(environmentId, failure ?? null);
      }
      const notes: Array<string> = [];
      if (opencodex !== null) {
        setUpdateEverythingRun((run) => run && { ...run, phase: "servers" });
        const checked = await checkOpenCodexUpdate.run(appAtomRegistry, {
          environmentId: opencodex,
          input: {},
        });
        const key = `opencodex:${opencodex}`;
        if (checked._tag === "Failure") {
          const error = squashAtomCommandFailure(checked);
          settleUpdateRunMachine(
            key,
            error instanceof Error ? error.message : "Could not check for an OpenCodex update.",
          );
        } else if (checked.value === null) {
          settleUpdateRunMachine(key, "Managed OpenCodex updates are off on this Hub.");
        } else {
          settleUpdateRunMachine(key, null);
          if (checked.value.decision === "wait") {
            notes.push(
              `OpenCodex waits for ${checked.value.waitingOn.map((alias) => alias ?? "this Mac").join(", ") || "idle"}; it updates once they are idle.`,
            );
          }
        }
      }
      setUpdateEverythingRun((run) => run && closeFinishedUpdateRun({ ...run, phase: "servers" }));
      const result = collectUpdateEverythingResult({
        localVersion: null,
        localFailures: [],
        servers: [],
        providers: outcomes,
      });
      showUpdateEverythingResult({ ...result, notes });
    } catch (error) {
      setUpdateEverythingRun(() => null);
      throw error;
    }
  };

  return {
    hasUpdates: remoteCount > 0 || providerMachines.length > 0,
    /** Which kinds of remote work are behind, so the button can name them. */
    remote: { providers: providerMachines.length > 0, servers: remoteCount > 0 },
    counts: { app: appTab.rows.length, runtimes: providerMachines.length },
    appTab,
    providerMachines,
    localEnvironmentId,
    runApp,
    runRuntimes,
  };
}

export type UpdateEverything = ReturnType<typeof useUpdateEverything>;
export type { ServerUpdateTarget };
