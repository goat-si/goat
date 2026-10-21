import { defenderExclusionCommand, type ServerWorktreeCheckoutHealth } from "@goat/contracts";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

export function worktreeCheckoutNeedsAttention(
  health: ServerWorktreeCheckoutHealth | undefined,
): health is ServerWorktreeCheckoutHealth {
  return health?.defender === "scanning" || health?.defender === "unverified";
}

/**
 * Shown for a Windows environment whose thread worktrees Microsoft Defender scans file by
 * file, which is what makes their checkouts slow. GOAT only reads Defender's state; the
 * person runs the exclusion themselves, as an administrator on that machine.
 */
export function WorktreeCheckoutHealthNotice({
  health,
  hostLabel,
}: {
  readonly health: ServerWorktreeCheckoutHealth | undefined;
  readonly hostLabel: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "command" });
  if (!worktreeCheckoutNeedsAttention(health)) return null;
  const command = defenderExclusionCommand(health.worktreesDirectory);
  return (
    <Alert variant="warning" className="mt-2">
      <AlertTitle>
        {health.defender === "scanning"
          ? "Microsoft Defender scans new worktrees"
          : "Microsoft Defender may scan new worktrees"}
      </AlertTitle>
      <AlertDescription>
        <div className="flex flex-col gap-1.5">
          <p>
            Real-time protection checks every file a new thread worktree writes, so worktrees on{" "}
            {hostLabel} check out slowly.
            {health.defender === "unverified"
              ? " GOAT could not read Defender's exclusions, which needs administrator rights."
              : null}{" "}
            To exclude GOAT's worktree folder, run this in an administrator PowerShell on{" "}
            {hostLabel}:
          </p>
          <code className="block select-text break-all">{command}</code>
          <p>
            Or create a Dev Drive in Windows Settings and set{" "}
            <b>Settings → Storage → Worktree location</b> to a folder on it. Defender scans a Dev
            Drive after files are written.
          </p>
          <div>
            <Button variant="outline" size="xs" onClick={() => copyToClipboard(command, undefined)}>
              {isCopied ? "Copied" : "Copy command"}
            </Button>
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}
