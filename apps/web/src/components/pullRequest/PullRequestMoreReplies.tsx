import type { ScopedThreadRef } from "@goat/contracts";

import { useOpenLink } from "~/browser/useOpenLink";

import type { PullRequestReplyAvailability } from "./pullRequestDetail.logic";

export function PullRequestMoreReplies({
  moreReplies,
  hasMoreReplies,
  url,
  threadRef,
}: PullRequestReplyAvailability & { threadRef: ScopedThreadRef | null }) {
  const openLink = useOpenLink(threadRef);
  if (!hasMoreReplies) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-2 py-1 text-xs text-muted-foreground">
      <span>
        {moreReplies > 0
          ? `${moreReplies.toLocaleString()} more ${moreReplies === 1 ? "reply" : "replies"}`
          : "More replies"}
      </span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground hover:underline"
          onClick={(event) => {
            event.preventDefault();
            void openLink(url, { event }).catch(console.error);
          }}
        >
          View on host
        </a>
      ) : null}
    </div>
  );
}
