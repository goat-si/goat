import type { useNavigate } from "@tanstack/react-router";
import {
  type AtomCommand,
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";

import {
  type ComposerDraftStoreState,
  type DraftId,
  type DraftSshDestination,
  useComposerDraftStore,
} from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { environmentCatalog } from "../../connection/catalog";
import { findSavedSshWorktreeOption, savedSshWorktreeOptions } from "../../lib/sshWorktree";
import type {
  SshThreadOpenPorts,
  SshWorktreeSubmissionPorts,
} from "../../lib/sshWorktreeSubmission";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { waitForThreadShell } from "../../state/entities";
import { vcsEnvironment } from "../../state/vcs";
import { buildThreadRouteParams } from "../../threadRoutes";
import { isDraftContentUnchanged } from "../ChatView.logic";

type CommandRunner<C> =
  C extends AtomCommand<infer W, infer A, infer E>
    ? (value: W) => Promise<AtomCommandResult<A, E>>
    : never;

/** The hook values the SSH send ports read when they run. */
export interface SshComposerPortDeps {
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly launchSshWorkspace: CommandRunner<typeof vcsEnvironment.sshWorkspaceLaunch>;
  readonly retryEnvironment: CommandRunner<typeof environmentCatalog.retryNow>;
  readonly clearDraftThread: ComposerDraftStoreState["clearDraftThread"];
  readonly clearComposerDraftContent: ComposerDraftStoreState["clearComposerContent"];
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly composerRef: ComposerHandleRef;
  readonly promptRef: { current: string };
}

export function sshComposerPorts(deps: SshComposerPortDeps) {
  const {
    navigate,
    launchSshWorkspace,
    retryEnvironment,
    clearDraftThread,
    clearComposerDraftContent,
    currentRouteThreadKeyRef,
    composerRef,
    promptRef,
  } = deps;
  const makeSshThreadOpenPorts = (
    savedDestination: DraftSshDestination,
    automaticRouteKey: string | null,
  ): SshThreadOpenPorts => ({
    reconnect: async (savedEnvironmentId) => {
      const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
      const option = findSavedSshWorktreeOption(
        savedSshWorktreeOptions(catalog.entries, window.desktopBridge !== undefined),
        savedDestination,
      );
      if (
        !catalog.isReady ||
        !option ||
        option.disabledReason ||
        savedEnvironmentId !== savedDestination.environmentId
      ) {
        throw new Error("This saved SSH connection is unavailable. Check Settings → Connections.");
      }
      const result = await retryEnvironment(savedEnvironmentId);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    waitForShell: waitForThreadShell,
    navigate: async (remoteRef) => {
      if (automaticRouteKey !== null && currentRouteThreadKeyRef.current !== automaticRouteKey) {
        throw new Error("The remote thread started. Use Open thread when ready.");
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(remoteRef),
        replace: true,
      });
    },
  });
  const makeSshSubmissionPorts = (
    capturedDraftId: DraftId,
    submittedContentSnapshot: string,
    savedDestination: DraftSshDestination,
    capturedRouteThreadKey: string,
    onDispatchBegan: () => void,
  ): SshWorktreeSubmissionPorts => {
    return {
      ...makeSshThreadOpenPorts(savedDestination, capturedRouteThreadKey),
      launch: async (target) => {
        onDispatchBegan();
        const result = await launchSshWorkspace(target);
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      },
      // Always re-read by captured ID, including after route changes or remounts.
      isSubmittedDraftContentUnchanged: () =>
        isDraftContentUnchanged(
          submittedContentSnapshot,
          useComposerDraftStore.getState().getComposerDraft(capturedDraftId),
        ),
      // Called synchronously after an unchanged-content comparison and successful navigation.
      deleteSubmittedDraft: () => clearDraftThread(capturedDraftId),
      // Called when navigation did not happen (timeout, route changed, identity mismatch): the draft
      // session stays so its route stays mounted. Called only when content still matches the
      // snapshot; remove it through the existing selector alias, never the displayed target.
      emptySubmittedDraftContent: () => {
        clearComposerDraftContent(capturedDraftId); // ChatView.tsx:1833 → composerDraftStore.ts:4186
        if (currentRouteThreadKeyRef.current === capturedRouteThreadKey) {
          promptRef.current = "";
          composerRef.current?.resetCursorState();
        }
      },
    };
  };
  return { makeSshThreadOpenPorts, makeSshSubmissionPorts };
}

export type SshComposerPorts = ReturnType<typeof sshComposerPorts>;
