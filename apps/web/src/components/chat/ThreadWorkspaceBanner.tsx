import type { ScopedThreadRef, ThreadWorkspaceState } from "@goat/contracts";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { useState } from "react";
import { Button } from "../ui/button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadWorkspaceBanner({
  threadRef,
  state,
  refresh,
}: {
  threadRef: ScopedThreadRef;
  state: ThreadWorkspaceState;
  refresh: () => void;
}) {
  const restore = useAtomCommand(serverEnvironment.restoreThreadWorkspace, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state !== "cleaned" && state !== "missing") return null;
  const run = async (mode: "restore" | "fresh") => {
    setPending(true);
    setError(null);
    try {
      const result = await restore({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, mode },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          typeof failure === "object" &&
            failure !== null &&
            "detail" in failure &&
            typeof failure.detail === "string"
            ? failure.detail
            : failure instanceof Error
              ? failure.message
              : "Could not restore the worktree.",
        );
      } else refresh();
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 p-2">
      <div>
        <div>
          {state === "cleaned"
            ? "This thread's worktree was cleaned up to save space."
            : "This thread's worktree folder is missing."}
        </div>
        <div>Sending a message also restores it.</div>
        {error && <div role="alert">{error}</div>}
      </div>
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void run("restore")}>
        {pending ? "Restoring…" : state === "cleaned" ? "Restore" : "Recreate"}
      </Button>
      {error && (
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => void run("fresh")}>
          Start in a new worktree
        </Button>
      )}
    </div>
  );
}
