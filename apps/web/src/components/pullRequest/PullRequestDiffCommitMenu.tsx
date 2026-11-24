import type { PullRequestCommit } from "@goat/contracts";
import { ChevronDownIcon } from "~/components/solar";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function PullRequestDiffCommitMenu({
  commits: orderedCommits,
  commit,
  visibleCommitCount,
  onSelectedCommitChange,
  onShowMore,
}: {
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly commit: string | null;
  readonly visibleCommitCount: number;
  readonly onSelectedCommitChange: (oid: string | null) => void;
  readonly onShowMore: () => void;
}) {
  const selectedCommit = orderedCommits.find((entry) => entry.oid === commit);
  const scopeLabel = selectedCommit ? selectedCommit.messageHeadline : "All commits";
  return orderedCommits.length > 0 ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="xs" variant="secondary" />}
        className="min-w-0 max-w-64 shrink-[999]"
        aria-label={`Diff scope: ${scopeLabel}`}
      >
        <span className="truncate">{scopeLabel}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[min(28rem,calc(100vw-2rem))]">
        <DropdownMenuRadioGroup
          value={commit ?? "all"}
          onValueChange={(value) => onSelectedCommitChange(value === "all" ? null : value)}
        >
          <DropdownMenuRadioItem value="all" closeOnClick>
            <span>All commits</span>
          </DropdownMenuRadioItem>
          {orderedCommits.slice(0, visibleCommitCount).map((entry) => (
            <DropdownMenuRadioItem key={entry.oid} value={entry.oid} closeOnClick>
              <span className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="min-w-0 truncate">{entry.messageHeadline}</span>}
                  />
                  <TooltipPopup side="top">{entry.messageHeadline}</TooltipPopup>
                </Tooltip>
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                  {entry.oid.slice(0, 7)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {orderedCommits.length > visibleCommitCount ? (
          <DropdownMenuItem closeOnClick={false} onClick={onShowMore}>
            <span className="text-muted-foreground">
              Show more ({orderedCommits.length - visibleCommitCount} left)
            </span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
}
