import {
  describeThreadWorkspaceRestore,
  type ScopedThreadRef,
  type ThreadWorkspaceStatus,
} from "@goat/contracts";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { useState } from "react";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** A thread's worktree that is gone, cleaned up, or back without its setup, and the ways forward. */
export function threadWorkspaceNeedsAttention(status: ThreadWorkspaceStatus | null | undefined) {
  return (
    status != null &&
    (status.state === "cleaned" || status.state === "missing" || status.setupIncomplete === true)
  );
}

export function ThreadWorkspaceBanner({
  threadRef,
  status,
  refresh,
}: {
  threadRef: ScopedThreadRef;
  status: ThreadWorkspaceStatus;
  refresh: () => void;
}) {
  const restore = useAtomCommand(serverEnvironment.restoreThreadWorkspace, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<"restore" | "fresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!threadWorkspaceNeedsAttention(status)) return null;
  const setupOnly = status.state === "present";
  const failed = (detail: string) => {
    setPending(null);
    setError(detail);
  };
  const run = (mode: "restore" | "fresh") => {
    setPending(mode);
    setError(null);
    restore({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, mode },
    }).then(
      (result) => {
        if (result._tag === "Success") {
          setPending(null);
          const { summary, lost } = describeThreadWorkspaceRestore({
            ...result.value,
            ...(status.branch === null ? {} : { previousBranch: status.branch }),
          });
          toastManager.add({
            type: "success",
            title: summary,
            ...(lost === null ? {} : { description: lost }),
          });
          refresh();
          return;
        }
        const failure = squashAtomCommandFailure(result);
        failed(
          typeof failure === "object" &&
            failure !== null &&
            "detail" in failure &&
            typeof failure.detail === "string"
            ? failure.detail
            : failure instanceof Error
              ? failure.message
              : "Could not restore the worktree.",
        );
      },
      () => failed("Could not restore the worktree."),
    );
  };
  const branch = status.branch ?? "its branch";
  const [title, body] = setupOnly
    ? [
        "This worktree was recreated, but its setup did not finish.",
        "GOAT runs setup again before the next turn. You can also run it now.",
      ]
    : status.state === "cleaned"
      ? [
          "This thread's worktree was cleaned up to save space.",
          "Restore brings back its files from the snapshot taken before cleanup. Sending a message restores it too.",
        ]
      : [
          "This thread's worktree folder is missing.",
          `Recreate rebuilds it from ${branch}. Sending a message does the same.`,
        ];
  const primary = setupOnly
    ? pending === "restore"
      ? "Running setup…"
      : "Run setup now"
    : pending === "restore"
      ? "Restoring…"
      : status.state === "cleaned"
        ? "Restore"
        : "Recreate";
  return (
    <div className="flex flex-wrap items-center gap-2 p-2">
      <div className="min-w-0 flex-1">
        <div>{title}</div>
        <div>{body}</div>
        {error && (
          <div role="alert">
            {error} Start in a new worktree to keep working; the branch and any snapshot stay.
          </div>
        )}
      </div>
      <Button size="xs" variant="ghost" disabled={pending !== null} onClick={() => run("restore")}>
        {primary}
      </Button>
      {!setupOnly && (
        <Button size="xs" variant="ghost" disabled={pending !== null} onClick={() => run("fresh")}>
          {pending === "fresh" ? "Starting…" : "Start in a new worktree"}
        </Button>
      )}
    </div>
  );
}
