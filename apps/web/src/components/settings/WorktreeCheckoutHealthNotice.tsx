import { defenderExclusionCommand, type ServerWorktreeCheckoutHealth } from "@goat/contracts";
import { useState } from "react";

import { ChevronRightIcon } from "~/components/solar";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

export function worktreeCheckoutNeedsAttention(
  health: ServerWorktreeCheckoutHealth | undefined,
): health is ServerWorktreeCheckoutHealth {
  return health?.defender === "scanning" || health?.defender === "unverified";
}

/**
 * Shown for a Windows environment whose thread worktrees Microsoft Defender scans file by
 * file, which is what makes their checkouts slow. GOAT only reads Defender's state; the
 * person runs the exclusion themselves, as an administrator on that machine.
 * It starts folded to its title line because it repeats on every Windows host row.
 */
export function WorktreeCheckoutHealthNotice({
  health,
  hostLabel,
}: {
  readonly health: ServerWorktreeCheckoutHealth | undefined;
  readonly hostLabel: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "command" });
  const [open, setOpen] = useState(false);
  if (!worktreeCheckoutNeedsAttention(health)) return null;
  const command = defenderExclusionCommand(health.worktreesDirectory);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
      <Alert variant="warning">
        <AlertTitle>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            {health.defender === "scanning"
              ? "Microsoft Defender scans new worktrees"
              : "Microsoft Defender may scan new worktrees"}
          </CollapsibleTrigger>
        </AlertTitle>
        <AlertDescription>
          <CollapsiblePanel>
            <div className="flex flex-col gap-1.5 pt-1">
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
                <b>Settings → Storage → Worktree location</b> to a folder on it. Defender scans a
                Dev Drive after files are written.
              </p>
              <div>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => copyToClipboard(command, undefined)}
                >
                  {isCopied ? "Copied" : "Copy command"}
                </Button>
              </div>
            </div>
          </CollapsiblePanel>
        </AlertDescription>
      </Alert>
    </Collapsible>
  );
}
