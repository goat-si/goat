import type { DraftSshDestination } from "../../composerDraftStore";
import {
  openSshThread,
  type SshThreadOpenPorts,
  type SshWorktreeSubmissionOutcome,
} from "../../lib/sshWorktreeSubmission";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The warning for an SSH thread that started but could not be opened, with an Open action. */
export const sshStartedNotOpenedToast =
  (
    makeSshThreadOpenPorts: (
      destination: DraftSshDestination,
      automaticRouteKey: string | null,
    ) => SshThreadOpenPorts,
  ) =>
  (
    outcome: Extract<SshWorktreeSubmissionOutcome, { kind: "started-not-opened" }>,
    saved: { destination: DraftSshDestination; hostLabel: string },
  ) => {
    // This continuation captures remote identity only; Open cannot resend or consume a draft.
    const { remoteRef } = outcome;
    const { destination, hostLabel } = saved;
    const show = (reason: string) =>
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `Started on ${hostLabel.slice(0, 120)}, but could not open the thread`,
          description: `${remoteRef.threadId} · ${reason.slice(0, 500)}`,
          actionProps: {
            children: "Open thread",
            onClick: () => {
              void openSshThread(
                { remoteRef, savedEnvironmentId: destination.environmentId },
                makeSshThreadOpenPorts(destination, null),
              ).catch((error: unknown) =>
                show(error instanceof Error ? error.message : "Could not open the remote thread."),
              );
            },
          },
        }),
      );
    show(outcome.reason);
  };
