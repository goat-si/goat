import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type RemoteLaunch,
  type DesktopSshPreparationProgress,
} from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  presentRemoteLaunches,
  type RemoteLaunchHostGroup,
} from "@goat/client-runtime/state/remote-launches";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import { sshRuntimePhaseText } from "@goat/client-runtime/state/sshRuntime";
import { isSshConnectionSuperseded } from "./ConnectionsSettings.logic";

import { connectSshEnvironment as connectSshEnvironmentAtom } from "~/connection/onboarding";
import { useThreadShells } from "~/state/entities";
import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { EnvironmentRow } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";

const STATE_LABELS: Record<NonNullable<RemoteLaunch["state"]>, string> = {
  launching: "Launching",
  running: "Running",
  idle: "Idle",
  settled: "Done",
  cancelled: "Cancelled",
  lost: "Outcome unknown",
};

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);

function launchStatus(launch: RemoteLaunch): string {
  if (launch.hostUnavailableSince !== null) return "Host unreachable";
  return launch.state === null ? "Watched" : STATE_LABELS[launch.state];
}

/** Each connected environment's remote launches, for the environments that have any. */
const remoteLaunchesAtom = Atom.make((get) => {
  const listed: Array<{
    readonly environmentId: EnvironmentId;
    readonly launches: ReadonlyArray<RemoteLaunch>;
    readonly truncated: boolean;
  }> = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (presentation.connection.phase !== "connected") continue;
    const result = Option.getOrNull(
      AsyncResult.value(get(serverEnvironment.remoteLaunches({ environmentId, input: {} }))),
    );
    if (result !== null && result.launches.length > 0) listed.push({ environmentId, ...result });
  }
  return listed;
}).pipe(Atom.withLabel("web:settings:remote-launches"));

/**
 * Threads that connected environments launched on other machines over SSH.
 * A thread opens here when this client is connected to its machine too; on
 * desktop the machine can be added over SSH with the dispatcher's host alias.
 */
export function RemoteLaunchesSettings() {
  const { environments } = useEnvironments();
  const listed = useAtomValue(remoteLaunchesAtom);
  const shells = useThreadShells();
  const dispatchers = listed.flatMap((entry) => {
    const dispatcher = environments.find(
      (environment) => environment.environmentId === entry.environmentId,
    );
    if (dispatcher === undefined) return [];
    return [
      {
        dispatcher,
        truncated: entry.truncated,
        count: entry.launches.length,
        groups: presentRemoteLaunches({
          dispatcherEnvironmentId: entry.environmentId,
          launches: entry.launches,
          shells,
        }),
      },
    ];
  });
  if (dispatchers.length === 0) return null;
  const total = dispatchers.reduce((sum, entry) => sum + entry.count, 0);
  const { id, title } = searchableSetting("remote-launches");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={`${total} ${total === 1 ? "thread" : "threads"} on other machines`}
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Threads your environments started over SSH. Open one when this app is also connected to its
        machine.
      </p>
      {dispatchers.map(({ dispatcher, groups, truncated, count }) => (
        <div key={dispatcher.environmentId} className="border-t border-border/50">
          {dispatchers.length > 1 ? (
            <p className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground sm:px-4">
              From {dispatcher.label}
            </p>
          ) : null}
          {groups.map((group) => (
            <RemoteHostLaunches
              key={group.host}
              dispatcher={dispatcher}
              group={group}
              hostEnvironment={
                environments.find(
                  (environment) => environment.environmentId === group.environmentId,
                ) ?? null
              }
              shells={shells}
            />
          ))}
          {truncated ? (
            <p className="px-3 pb-2.5 text-xs text-muted-foreground sm:px-4">
              Showing the most recent {count}.
            </p>
          ) : null}
        </div>
      ))}
    </FoldedSettingsSection>
  );
}

function RemoteHostLaunches({
  dispatcher,
  group,
  hostEnvironment,
  shells,
}: {
  readonly dispatcher: EnvironmentPresentation;
  readonly group: RemoteLaunchHostGroup;
  readonly hostEnvironment: EnvironmentPresentation | null;
  readonly shells: ReturnType<typeof useThreadShells>;
}) {
  const navigate = useNavigate();
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const [connecting, setConnecting] = useState(false);
  const [preparation, setPreparation] = useState<DesktopSshPreparationProgress | null>(null);
  const submission = useRef(0);
  useEffect(
    () => () => {
      submission.current += 1;
    },
    [],
  );
  const canConnectOverSsh = window.desktopBridge !== undefined;
  const connectHost = async () => {
    if (connecting) return;
    const submissionId = ++submission.current;
    setConnecting(true);
    const connect = async () => {
      const result = await connectSshEnvironment({
        target: { alias: group.host, hostname: group.host, username: null, port: null },
        label: "",
        onPreparationProgress: (progress) =>
          Effect.sync(() => {
            if (submission.current === submissionId)
              setPreparation(progress.phase === null ? null : progress);
          }),
      });
      if (submission.current !== submissionId) return;
      if (result._tag === "Failure") {
        if (
          !isAtomCommandInterrupted(result) &&
          !isSshConnectionSuperseded(squashAtomCommandFailure(result))
        ) {
          toastManager.add({
            type: "error",
            title: `Could not connect ${group.host}`,
            description: errorMessage(squashAtomCommandFailure(result)),
          });
        }
        return;
      }
      toastManager.add({
        type: "success",
        title: `${group.host} connected`,
        description: "Its threads open from here once they load.",
      });
    };
    await connect()
      .catch((error: unknown) => {
        if (submission.current !== submissionId || isSshConnectionSuperseded(error)) return;
        toastManager.add({
          type: "error",
          title: `Could not connect ${group.host}`,
          description: errorMessage(error),
        });
      })
      .finally(() => {
        if (submission.current !== submissionId) return;
        submission.current += 1;
        setPreparation(null);
        setConnecting(false);
      });
  };
  return (
    <>
      <EnvironmentRow
        kind={resolveEnvironmentMachineKind(hostEnvironment?.serverConfig ?? null)}
        label={group.host}
        subtitle={
          preparation?.phase
            ? sshRuntimePhaseText(preparation.phase)
            : hostEnvironment !== null
              ? `Connected as ${hostEnvironment.label}`
              : canConnectOverSsh
                ? `Not connected to this app. Connect over SSH as ${group.host}.`
                : `Not connected to this app. Pair ${group.host} under Environments to open these threads.`
        }
      >
        {hostEnvironment === null && canConnectOverSsh ? (
          <Button
            size="xs"
            variant="outline"
            disabled={connecting}
            onClick={() => void connectHost()}
          >
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        ) : null}
      </EnvironmentRow>
      <ul className="pb-1.5">
        {group.launches.map((entry, index) => {
          const launcherTitle =
            shells.find(
              (shell) =>
                shell.environmentId === dispatcher.environmentId &&
                shell.id === entry.launch.launcherThreadId,
            )?.title ?? null;
          const ref = entry.ref;
          return (
            <li
              key={entry.launch.threadId ?? `pending-${index}`}
              className="flex items-center gap-2 py-1.5 pr-3 pl-10 sm:pr-4 sm:pl-11"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {entry.title ?? (entry.launch.threadId === null ? "Not started" : "Untitled")}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    launchStatus(entry.launch),
                    launcherTitle === null ? null : `Launched by ${launcherTitle}`,
                    entry.launch.latest?.summary ?? null,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(" · ")}
                </p>
              </div>
              {launcherTitle !== null ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(dispatcher.environmentId, entry.launch.launcherThreadId),
                      ),
                    })
                  }
                >
                  Launcher
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={ref === null}
                onClick={() => {
                  if (ref === null) return;
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(ref),
                  });
                }}
              >
                Open
              </Button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
