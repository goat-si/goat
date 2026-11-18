import type { ComposerDispatchMode } from "@goat/client-runtime/state/composer-dispatch";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import type { SessionPhase } from "../types";

const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s|$)/i;

/** How a composer send dispatches: where it runs and whether it waits behind other work. */
export function planComposerTurn(input: {
  readonly messageText: string;
  readonly sendQueuesBehindSetup: boolean;
  readonly isServerThread: boolean;
  /** A cloud thread runs in the provider's own workspace, so it never gets a local worktree. */
  readonly isCloudThread?: boolean;
  readonly activeMessageCount: number;
  readonly sendEnvMode: DraftThreadEnvMode;
  readonly worktreePath: string | null;
  readonly activeThreadBranch: string | null;
  readonly isScratchProject?: boolean;
  readonly resumeCompactionTokens: number | null;
  readonly keepFullHistory: boolean;
  readonly phase: SessionPhase;
  readonly dispatchMode: ComposerDispatchMode;
}) {
  const isFirstMessage =
    !input.sendQueuesBehindSetup && (!input.isServerThread || input.activeMessageCount === 0);
  const shouldCreateWorktree =
    input.isCloudThread !== true &&
    isFirstMessage &&
    input.sendEnvMode === "worktree" &&
    !input.worktreePath;
  // A stale Claude session compacts before this message so the turn does not re-read the
  // old history. The message queues behind the /compact run, since steering into it is
  // rejected.
  const compactBeforeSend =
    input.resumeCompactionTokens !== null &&
    !input.keepFullHistory &&
    !COMPACT_COMMAND_PATTERN.test(input.messageText);
  return {
    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    missingWorktreeBaseBranch:
      shouldCreateWorktree && !input.activeThreadBranch && !input.isScratchProject,
    baseBranchForWorktree: shouldCreateWorktree ? input.activeThreadBranch : null,
    compactBeforeSend,
    turnDispatchMode:
      compactBeforeSend || input.sendQueuesBehindSetup ? ("queue" as const) : input.dispatchMode,
    shouldQueueBehindActiveRun:
      compactBeforeSend ||
      input.sendQueuesBehindSetup ||
      (input.phase === "running" && input.dispatchMode === "queue"),
  };
}
