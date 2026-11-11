import type { EnvironmentProject, EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  threadForkAvailability,
  type ThreadForkAvailability,
} from "@goat/client-runtime/state/thread-workflows";
import type {
  EnvironmentId,
  OrchestrationV2ThreadForkWorkspace,
  RunId,
  ServerProvider,
  ThreadId,
} from "@goat/contracts";
import * as Haptics from "expo-haptics";
import { useCallback } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { readEnvironmentProxiedByHub } from "../../state/session";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import {
  buildForkMenuActions,
  FORK_THREAD_PICKER,
  forkChoices,
  forkEntryChoice,
  forkWorkspaceForMenuEvent,
  type ForkChoice,
  type ForkEntryChoice,
} from "./threadForkChoices";
import { runThreadFork, type ThreadForkRequest } from "./threadForkFlow";
import { waitForThreadShellReady } from "./threadForkNavigation";

/** Mobile's inputs to the shared availability rule. Git state is unknown here, so only scratch withholds the worktree. */
export function mobileThreadForkAvailability(input: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "sideChatOf" | "worktreePath"> & {
    readonly latestRunId: RunId | null;
  };
  readonly forkWorkspaceSupported: boolean;
  readonly project: Pick<EnvironmentProject, "isScratch"> | null;
  readonly cloud: boolean;
}): ThreadForkAvailability {
  return threadForkAvailability({
    thread: {
      sideChatOf: input.thread.sideChatOf ?? null,
      latestRunId: input.thread.latestRunId,
      worktreePath: input.thread.worktreePath,
    },
    capabilities: { threadForkWorkspace: input.forkWorkspaceSupported },
    project: input.project?.isScratch === true ? { isGitRepository: false, isScratch: true } : null,
    cloud: input.cloud,
    viaHubProxy: readEnvironmentProxiedByHub(input.thread.environmentId),
  });
}

/** A cloud agent works in its vendor's environment, so it has no checkout to branch. */
export function threadRunsInCloud(
  thread: Pick<EnvironmentThreadShell, "runtime" | "modelSelection">,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "executionLocation">> | undefined,
): boolean {
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  return (
    providers?.find((provider) => provider.instanceId === instanceId)?.executionLocation === "cloud"
  );
}

export async function waitForThreadShell(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  return waitForThreadShellReady({
    read: () => appAtomRegistry.get(atom) !== null,
  });
}

function chooseForkWorkspace(picker: {
  readonly title: string;
  readonly message: string | undefined;
  readonly choices: readonly [ForkChoice, ForkChoice];
}): Promise<OrchestrationV2ThreadForkWorkspace | null> {
  return new Promise((resolve) => {
    Dialog.alert(
      picker.title,
      picker.message,
      [
        ...picker.choices.map((choice) => ({
          text: choice.label,
          onPress: () => resolve(choice.workspace),
        })),
        { text: "Cancel", style: "cancel" as const, onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}

function confirmWithoutUncommitted(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    Dialog.alert(
      "Uncommitted changes can't be carried",
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Fork without uncommitted changes", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export type ThreadForkTarget = Omit<ThreadForkRequest, "workspace">;

export function useForkThread() {
  const execute = useAtomCommand(threadEnvironment.fork, {
    label: "fork thread",
    reportFailure: false,
  });
  const selectDetail = useSelectWorkspaceDetail();

  const fork = useCallback(
    (request: ThreadForkRequest) => {
      void Haptics.selectionAsync();
      return runThreadFork(request, {
        execute,
        newId: uuidv4,
        confirmWithoutUncommitted,
        openThread: async (environmentId, threadId) => {
          if (!(await waitForThreadShell(environmentId, threadId))) {
            Dialog.alert(
              "Fork created",
              "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
            );
            return;
          }
          selectDetail({ name: "Thread", params: { environmentId, threadId } });
        },
        showError: (message) => Dialog.alert("Could not fork thread", message),
      });
    },
    [execute, selectDetail],
  );

  /** Runs a fork entry: explains a refusal, forks in place, or asks where first. */
  const start = async (
    target: ThreadForkTarget,
    choice: ForkEntryChoice,
    picker: Parameters<typeof chooseForkWorkspace>[0],
  ) => {
    if (choice.kind === "blocked") {
      Dialog.alert("Can't fork this thread", choice.reason);
      return;
    }
    const workspace =
      choice.kind === "current" ? { type: "current" as const } : await chooseForkWorkspace(picker);
    if (workspace !== null) await fork({ ...target, workspace });
  };

  return { fork, start };
}

/** /fork in a thread's composer, picked from the list or typed and sent. */
export function useComposerFork(input: {
  readonly thread: EnvironmentThreadShell;
  readonly serverConfig: {
    readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "executionLocation">>;
    readonly environment: { readonly capabilities: { readonly threadForkWorkspace?: boolean } };
  } | null;
  readonly project: Pick<EnvironmentProject, "isScratch"> | null;
  readonly enabled: boolean;
}) {
  const { start } = useForkThread();
  const { thread, serverConfig } = input;
  const serverForks = serverConfig?.environment.capabilities.threadForkWorkspace === true;
  const availability = mobileThreadForkAvailability({
    thread: { ...thread, latestRunId: thread.latestRun?.runId ?? null },
    forkWorkspaceSupported: serverForks,
    project: input.project,
    cloud: threadRunsInCloud(thread, serverConfig?.providers),
  });
  const startFork = () =>
    void start(
      {
        environmentId: thread.environmentId,
        sourceThreadId: thread.id,
        sourceTitle: thread.title,
        serverForks,
      },
      forkEntryChoice(availability),
      {
        title: FORK_THREAD_PICKER.title,
        message: FORK_THREAD_PICKER.message(availability.inWorktree),
        choices: forkChoices(availability.inWorktree, "thread"),
      },
    );
  return { offersFork: input.enabled && availability.canFork, startFork };
}

/** "Fork thread" in a thread-list row's long-press menu. */
export function useThreadRowFork(input: {
  readonly thread: EnvironmentThreadShell;
  readonly canOperateThread: boolean;
  readonly forkWorkspaceSupported: boolean;
  readonly project: Pick<EnvironmentProject, "isScratch"> | null;
  readonly providers:
    | ReadonlyArray<Pick<ServerProvider, "instanceId" | "executionLocation">>
    | undefined;
}) {
  const { fork } = useForkThread();
  const { thread, forkWorkspaceSupported } = input;
  const menuActions = buildForkMenuActions(
    input.canOperateThread
      ? mobileThreadForkAvailability({
          thread: { ...thread, latestRunId: thread.latestRun?.runId ?? null },
          forkWorkspaceSupported,
          project: input.project,
          cloud: threadRunsInCloud(thread, input.providers),
        })
      : null,
  );
  const handleMenuEvent = useCallback(
    (event: string) => {
      const workspace = forkWorkspaceForMenuEvent(event);
      if (workspace === null) return false;
      void fork({
        environmentId: thread.environmentId,
        sourceThreadId: thread.id,
        sourceTitle: thread.title,
        workspace,
        serverForks: forkWorkspaceSupported,
      });
      return true;
    },
    [fork, forkWorkspaceSupported, thread.environmentId, thread.id, thread.title],
  );
  return { menuActions, handleMenuEvent };
}
