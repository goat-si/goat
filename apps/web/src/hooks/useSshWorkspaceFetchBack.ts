import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentAuthorizationError,
  SshWorkspaceError,
  type ScopedThreadRef,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { sshWorkspaceErrorCopy } from "~/lib/sshWorktreeSubmission";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProject, useThreadShell } from "~/state/entities";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentProjects } from "~/state/projects";
import { environmentThreadShells } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { toastManager } from "~/components/ui/toast";
import {
  resolveGitActionResultToastTiming,
  resolveSshFetchBackContext,
} from "~/components/GitActionsControl.logic";

const isSshWorkspaceError = Schema.is(SshWorkspaceError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const pendingByThread = Atom.family((_key: string) => Atom.make(false));
const sshWorkspaceFetchBack = vcsEnvironment.sshWorkspaceFetchBack;
type FetchBackTarget = NonNullable<ReturnType<typeof resolveSshFetchBackContext>["target"]>;

function readContext(threadRef: ScopedThreadRef | null) {
  const thread =
    threadRef === null
      ? null
      : appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef));
  const project =
    threadRef === null || thread === null
      ? null
      : appAtomRegistry.get(
          environmentProjects.projectAtom({
            environmentId: threadRef.environmentId,
            projectId: thread.projectId,
          }),
        );
  return resolveSshFetchBackContext({
    isDesktop: typeof window !== "undefined" && window.desktopBridge !== undefined,
    threadRef,
    thread,
    workspaceRoot: project?.workspaceRoot ?? null,
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    catalog: appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries,
  });
}

export function useSshWorkspaceFetchBack(threadRef: ScopedThreadRef | null) {
  const thread = useThreadShell(threadRef);
  const project = useProject(
    threadRef === null || thread === null
      ? null
      : {
          environmentId: threadRef.environmentId,
          projectId: thread.projectId,
        },
  );
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const context = resolveSshFetchBackContext({
    isDesktop: typeof window !== "undefined" && window.desktopBridge !== undefined,
    threadRef,
    thread,
    workspaceRoot: project?.workspaceRoot ?? null,
    primaryEnvironmentId,
    catalog: catalog.entries,
  });
  const pendingAtom = pendingByThread(
    JSON.stringify([threadRef?.environmentId ?? null, threadRef?.threadId ?? null]),
  );
  const isPending = useAtomValue(pendingAtom);
  const permitted = useAtomValue(
    sshWorkspaceFetchBack.permissionAtom(
      context.target?.environmentId ?? null,
      context.target?.input,
    ),
  );
  const disabledReason =
    context.disabledReason ??
    (context.visible && !permitted
      ? "This device's connection cannot change source control."
      : isPending
        ? "Fetching branch to this device..."
        : null);
  const execute = useAtomCommand(sshWorkspaceFetchBack, {
    reportFailure: false,
    reportDefect: false,
  });
  const refreshLocalStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
    reportDefect: false,
  });
  const fetchBack = async (target: FetchBackTarget): Promise<void> => {
    const result = await execute(target);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Fetch branch failed",
        description: isSshWorkspaceError(error)
          ? sshWorkspaceErrorCopy[error.code].replaceAll(
              "<host>",
              target.input.target.alias.slice(0, 120),
            )
          : isEnvironmentAuthorizationError(error)
            ? "This device's connection cannot change source control."
            : "Could not fetch the remote branch. Check the connection before trying again.",
        timeout: 0,
        data: { threadRef },
      });
      return;
    }
    const timing = resolveGitActionResultToastTiming("success");
    toastManager.add({
      type: "success",
      title: "Branch fetched to this device",
      description: result.value.localRef,
      timeout: timing.timeout,
      data: {
        threadRef,
        ...(timing.dismissAfterVisibleMs === null
          ? {}
          : {
              dismissAfterVisibleMs: timing.dismissAfterVisibleMs,
            }),
      },
    });
    // refreshStatus invalidates live and persisted local refs in onSettled.
    const refreshed = await refreshLocalStatus({
      environmentId: target.environmentId,
      input: { cwd: result.value.localWorkspaceRoot },
    });
    if (refreshed._tag === "Failure" && !isAtomCommandInterrupted(refreshed)) {
      const error = squashAtomCommandFailure(refreshed);
      toastManager.add({
        type: "error",
        title: "Branch fetched; local Git status refresh failed",
        description:
          error instanceof Error ? error.message : "Refresh Git status to see the fetched ref.",
        timeout: 0,
        data: { threadRef },
      });
    }
  };
  const run = async (): Promise<void> => {
    if (appAtomRegistry.get(pendingAtom)) return;
    // Read again: a retained palette row can outlive a branch/catalog/grant change.
    const current = readContext(threadRef);
    if (!current.visible) return;
    const target = current.target;
    const canRun =
      target !== null &&
      appAtomRegistry.get(sshWorkspaceFetchBack.permissionAtom(target.environmentId, target.input));
    if (target === null || !canRun) {
      toastManager.add({
        type: "error",
        title: "Cannot fetch branch to this device",
        description:
          current.disabledReason ?? "This device's connection cannot change source control.",
        timeout: 0,
        data: { threadRef },
      });
      return;
    }
    // Retain the guard even when navigation unmounts every menu/palette subscriber.
    const releasePending = appAtomRegistry.mount(pendingAtom);
    appAtomRegistry.set(pendingAtom, true);
    // Promise.finally: the React Compiler cannot compile a try/finally.
    await fetchBack(target).finally(() => {
      appAtomRegistry.set(pendingAtom, false);
      releasePending();
    });
  };
  return {
    visible: context.visible,
    isPending,
    disabled: !context.visible || context.target === null || !permitted || isPending,
    disabledReason,
    label: isPending ? "Fetching branch to this device..." : "Fetch branch to this device",
    run,
  };
}
