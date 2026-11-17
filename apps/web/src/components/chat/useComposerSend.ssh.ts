import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { environmentCatalog } from "../../connection/catalog";
import type { SavedSshWorktreeOption } from "../../lib/sshWorktree";
import {
  findSavedSshWorktreeOption,
  savedSshWorktreeOptions,
  sshThreadHandoffBlockReason,
} from "../../lib/sshWorktree";
import {
  openSshThread,
  remoteRefOf,
  sshWorktreeErrorFeedback,
} from "../../lib/sshWorktreeSubmission";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  sshComposerPorts,
  type SshComposerPortDeps,
  type SshComposerPorts,
} from "./sshComposerPorts";
import { sshStartedNotOpenedToast } from "./sshStartedNotOpenedToast";
import type { ComposerSendInput } from "./useComposerSend.input";

const sshWorkspaceLaunchCommand = vcsEnvironment.sshWorkspaceLaunch;

/** The SSH ports a send uses and its "continue on SSH" action, rebuilt each render as before. */
export function composerSshContinuation(
  deps: SshComposerPortDeps &
    Pick<
      ComposerSendInput,
      "environmentId" | "routeThreadRef" | "routeThreadKey" | "sshHandoffGuard"
    > & {
      readonly sendInFlightRef: { current: boolean };
    },
) {
  const {
    navigate,
    launchSshWorkspace,
    retryEnvironment,
    clearDraftThread,
    clearComposerDraftContent,
    currentRouteThreadKeyRef,
    composerRef,
    promptRef,
    sendInFlightRef,
    environmentId,
    routeThreadRef,
    routeThreadKey,
    sshHandoffGuard,
  } = deps;
  // Built when a send runs, as the inline factories were: the ports read refs, which render must not.
  const sshPorts = () =>
    sshComposerPorts({
      navigate,
      launchSshWorkspace,
      retryEnvironment,
      clearDraftThread,
      clearComposerDraftContent,
      currentRouteThreadKeyRef,
      composerRef,
      promptRef,
    });
  const makeSshThreadOpenPorts: SshComposerPorts["makeSshThreadOpenPorts"] = (...args) =>
    sshPorts().makeSshThreadOpenPorts(...args);
  const makeSshSubmissionPorts: SshComposerPorts["makeSshSubmissionPorts"] = (...args) =>
    sshPorts().makeSshSubmissionPorts(...args);
  const showSshStartedNotOpened: ReturnType<typeof sshStartedNotOpenedToast> = (...args) =>
    sshStartedNotOpenedToast(makeSshThreadOpenPorts)(...args);
  const continueThreadOnSsh = async (
    selected: SavedSshWorktreeOption,
    instructions: string,
  ): Promise<boolean> => {
    if (sendInFlightRef.current) return false;
    const source = readThreadShell(routeThreadRef);
    const projection = appAtomRegistry.get(
      environmentThreadDetails.threadAtom(routeThreadRef),
    )?.projection;
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const option = findSavedSshWorktreeOption(
      savedSshWorktreeOptions(catalog.entries, window.desktopBridge !== undefined),
      selected.destination,
    );
    const reason =
      sshThreadHandoffBlockReason({
        ...sshHandoffGuard,
        sourceThreadAvailable: source !== null,
        hasMessages: (projection?.messages.length ?? 0) > 0,
        runs: projection?.runs ?? [],
        catalogReady: catalog.isReady,
        options: savedSshWorktreeOptions(catalog.entries, window.desktopBridge !== undefined),
        canLaunch: appAtomRegistry.get(sshWorkspaceLaunchCommand.permissionAtom(environmentId)),
      }) ??
      option?.disabledReason ??
      (option === null ? "This saved SSH connection is unavailable. Choose another host." : null);
    if (reason !== null || source === null || option === null) {
      toastManager.add(
        stackedThreadToast({ type: "error", title: reason ?? "This thread is unavailable." }),
      );
      return false;
    }
    const capturedRouteKey = routeThreadKey;
    sendInFlightRef.current = true;
    let dispatchBegan = false;
    const launchSshThread = async () => {
      dispatchBegan = true;
      const result = await launchSshWorkspace({
        environmentId,
        input: {
          sourceProjectId: source.projectId,
          sourceThreadId: source.id,
          destination: {
            connectionId: option.destination.connectionId,
            expectedEnvironmentId: option.destination.environmentId,
            target: option.profile.target,
          },
          title: source.title,
          modelSelection: source.modelSelection,
          runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode,
          initialMessage: { text: instructions },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const remoteRef = remoteRefOf(result.value);
      try {
        await openSshThread(
          { remoteRef, savedEnvironmentId: option.destination.environmentId },
          makeSshThreadOpenPorts(option.destination, capturedRouteKey),
        );
      } catch (error) {
        showSshStartedNotOpened(
          {
            kind: "started-not-opened",
            remoteRef,
            reason: error instanceof Error ? error.message : "Could not open the remote thread.",
          },
          { destination: option.destination, hostLabel: option.label },
        );
      }
      return true;
    };
    return launchSshThread()
      .catch((error: unknown) => {
        const feedback = sshWorktreeErrorFeedback(error, option.label, dispatchBegan, "thread");
        toastManager.add(
          stackedThreadToast({
            type: feedback.uncertain ? "warning" : "error",
            title: feedback.message,
            description: feedback.details,
          }),
        );
        return false;
      })
      .finally(() => {
        sendInFlightRef.current = false;
      });
  };
  return { makeSshSubmissionPorts, showSshStartedNotOpened, continueThreadOnSsh };
}

export type SshContinuation = ReturnType<typeof composerSshContinuation>;
