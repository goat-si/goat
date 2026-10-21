import {
  EnvironmentAuthorizationError,
  SshWorkspaceError,
  type SshWorkspaceCode,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SshWorkspaceLaunchInput,
  SshWorkspaceLaunchResult,
} from "@goat/contracts";

type LaunchInput = SshWorkspaceLaunchInput;
type LaunchResult = SshWorkspaceLaunchResult;
export interface SshThreadOpenPorts {
  reconnect: (environmentId: EnvironmentId) => Promise<void>;
  waitForShell: (ref: ScopedThreadRef, timeoutMs: number) => Promise<boolean>;
  navigate: (ref: ScopedThreadRef) => Promise<void>;
}
export interface SshWorktreeSubmissionPorts extends SshThreadOpenPorts {
  launch: (target: { environmentId: EnvironmentId; input: LaunchInput }) => Promise<LaunchResult>;
  isSubmittedDraftContentUnchanged: () => boolean;
  deleteSubmittedDraft: () => void;
  emptySubmittedDraftContent: () => void;
}
export type SshWorktreeSubmissionOutcome =
  | { kind: "opened"; remoteRef: ScopedThreadRef }
  | { kind: "started-not-opened"; remoteRef: ScopedThreadRef; reason: string };
class SshWorktreeNavigationError extends Error {
  constructor(
    readonly remoteRef: ScopedThreadRef,
    message: string,
  ) {
    super(message);
    this.name = "SshWorktreeNavigationError";
  }
}
export function remoteRefOf(result: LaunchResult): ScopedThreadRef {
  return scopeThreadRef(result.remoteEnvironmentId, result.remoteThreadId);
}
async function navigateToSshThread(
  input: { remoteRef: ScopedThreadRef; savedEnvironmentId: EnvironmentId },
  ports: Pick<SshThreadOpenPorts, "waitForShell" | "navigate">,
): Promise<void> {
  try {
    if (input.remoteRef.environmentId !== input.savedEnvironmentId) {
      throw new Error("The host returned a different environment. Check Settings → Connections.");
    }
    const routeRef = scopeThreadRef(input.savedEnvironmentId, input.remoteRef.threadId);
    if (!(await ports.waitForShell(routeRef, 5_000))) {
      throw new Error("The remote thread has not appeared in this saved connection yet.");
    }
    await ports.navigate(routeRef);
  } catch (error) {
    throw new SshWorktreeNavigationError(
      input.remoteRef,
      error instanceof Error ? error.message : "Could not open the remote thread.",
    );
  }
}
// Used only by the toast action: it has no launch or draft mutation capability.
export async function openSshThread(
  input: { remoteRef: ScopedThreadRef; savedEnvironmentId: EnvironmentId },
  ports: SshThreadOpenPorts,
): Promise<void> {
  try {
    await ports.reconnect(input.savedEnvironmentId);
    await navigateToSshThread(input, ports);
  } catch (error) {
    if (error instanceof SshWorktreeNavigationError) throw error;
    throw new SshWorktreeNavigationError(
      input.remoteRef,
      error instanceof Error ? error.message : "Could not connect to the saved environment.",
    );
  }
}
export async function submitSshWorktree(
  input: {
    sourceEnvironmentId: EnvironmentId;
    savedEnvironmentId: EnvironmentId;
    launchInput: LaunchInput;
  },
  ports: SshWorktreeSubmissionPorts,
): Promise<SshWorktreeSubmissionOutcome> {
  const result = await ports.launch({
    environmentId: input.sourceEnvironmentId,
    input: input.launchInput,
  });
  const remoteRef = remoteRefOf(result);
  // Navigate BEFORE deleting the draft: deleting the open draft unmounts ChatView and redirects to "/"
  // (apps/web/src/components/ThreadRouteView.tsx:137, :169), which would cancel this continuation.
  try {
    await navigateToSshThread({ remoteRef, savedEnvironmentId: input.savedEnvironmentId }, ports);
  } catch (error) {
    // Acknowledged launch, failed opening: report the reason to onSend, never swallow it.
    // Compare and clear synchronously, with no intervening await; changed content stays untouched.
    if (ports.isSubmittedDraftContentUnchanged()) ports.emptySubmittedDraftContent();
    const reason = error instanceof Error ? error.message : "Could not open the remote thread.";
    return { kind: "started-not-opened", remoteRef, reason: reason.slice(0, 500) };
  }
  // Navigation resolved first. New text, attachments or contexts preserve the ordinary draft.
  if (ports.isSubmittedDraftContentUnchanged()) ports.deleteSubmittedDraft();
  return { kind: "opened", remoteRef };
}

export const sshWorkspaceErrorCopy = {
  invalid_target: "This saved SSH target is invalid. Choose another host or update Connections.",
  thread_not_found: "The local thread no longer exists. Open another thread.",
  thread_project_mismatch:
    "This thread no longer belongs to the selected project. Reopen it and try again.",
  thread_busy: "Wait for this thread's running and queued work to finish before continuing on SSH.",
  thread_worktree_invalid:
    "This thread's worktree is unavailable or invalid. Restore it before continuing on SSH.",
  project_not_found: "The local project no longer exists. Choose a local project.",
  not_git_repository: "SSH worktrees need a Git project.",
  project_not_repo_root: "Choose the repository root as the local project before sending to SSH.",
  project_read_failed: "Could not read the local project. Check access before trying again.",
  host_unavailable: "Could not reach <host>. Check its SSH connection before trying again.",
  remote_unsupported: "<host> needs an updated server to start SSH worktrees.",
  model_unavailable: "The selected model is unavailable on <host>. Choose a supported model.",
  environment_mismatch: "<host> returned a different environment. Check Settings → Connections.",
  invalid_remote_response:
    "<host> returned an invalid response. Check its server before trying again.",
  snapshot_failed: "Could not snapshot this project. Check the project before sending again.",
  unsupported_snapshot: "This repository cannot be copied as an SSH snapshot.",
  head_changed:
    "The local HEAD changed during the snapshot. Review the project before sending again.",
  secret_candidate:
    "Early warning: untracked credential-like files were found. Review the named files before sending.",
  foreign_path: "The remote path is not owned by this SSH workspace. Choose another destination.",
  remote_init_failed:
    "Could not prepare the workspace on <host>. Check its access and available space.",
  push_failed: "Could not copy the snapshot to <host>. Check the SSH connection and repository.",
  push_ref_conflict:
    "The snapshot reference already exists on <host>. Check the remote workspace before sending again.",
  push_oid_mismatch:
    "The snapshot on <host> does not match the local snapshot. Check the remote workspace.",
  launch_refused: "<host> refused to start the thread. Check its model and permissions.",
  launch_uncertain:
    "The thread may already have started on <host>; check its threads before sending again.",
  invalid_branch: "The remote branch is invalid. Choose a valid workspace branch.",
  source_not_found: "Could not find the local source project for this remote workspace.",
  source_ambiguous:
    "More than one local source project matches this remote workspace. Resolve the duplicate projects.",
  fetch_failed: "Could not fetch the remote changes. Check the SSH connection and repository.",
  caller_not_authorized: "You no longer have permission to start work on this SSH host.",
} satisfies Record<SshWorkspaceCode, string>;

const isSshWorkspaceError = Schema.is(SshWorkspaceError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);
export function sshWorktreeErrorFeedback(
  error: unknown,
  hostLabel: string,
  dispatchBegan: boolean,
  source: "draft" | "thread" = "draft",
) {
  const host = hostLabel.slice(0, 120);
  const typed = isSshWorkspaceError(error) ? error : null;
  const authorization = isEnvironmentAuthorizationError(error);
  const uncertain =
    typed?.code === "launch_uncertain" ||
    (typeof error === "object" &&
      error !== null &&
      "launchMayHaveStarted" in error &&
      error.launchMayHaveStarted === true) ||
    (!typed && !authorization && dispatchBegan);
  const message = uncertain
    ? sshWorkspaceErrorCopy.launch_uncertain.replaceAll("<host>", host)
    : authorization
      ? source === "thread"
        ? "This connection cannot copy code and start SSH threads."
        : "This connection cannot copy code and start SSH threads. Your draft was kept."
      : typed
        ? sshWorkspaceErrorCopy[typed.code].replaceAll("<host>", host)
        : source === "thread"
          ? `Could not continue this thread on ${host}.`
          : `Could not send to ${host}. Your draft was kept.`;
  const details = typed
    ? `${host} · ${typed.stage} · ${typed.code}${
        typed.code === "secret_candidate" && typed.fileNames
          ? ` · ${typed.fileNames
              .slice(0, 8)
              .map((name) => name.slice(0, 120))
              .join(", ")}`
          : ""
      }`
    : host;
  return { message, details, uncertain };
}
