import type { EnvironmentId } from "@goat/contracts";
import type { ReactNode } from "react";

import { MarkdownTableCopyOnCard } from "../chat/markdownTableCopyOnCard";
import { GoatBotLinkedText } from "./GoatBotLinkedText";
import type { GoatBotReplySplit } from "./goatBotReplyParts";

/**
 * One bot answer drawn as a stack of cards: the text around each table, and each table on a card
 * of its own. A card carries the reply's definitions, so a reference written after its table still
 * resolves. The last card ends with `trail`.
 */
export function GoatBotReplyCards({
  reply,
  environmentId,
  trail,
}: {
  readonly reply: GoatBotReplySplit;
  readonly environmentId: EnvironmentId | null;
  readonly trail: ReactNode;
}) {
  const last = reply.parts.length - 1;
  return (
    <div className="flex w-full max-w-[min(100%,34rem)] min-w-0 flex-col items-start gap-1">
      {reply.parts.map((part, index) =>
        part.kind === "table" ? (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
            key={index}
            className="goat-bot-prose goat-bot-card goat-bot-table w-full min-w-0"
          >
            <MarkdownTableCopyOnCard value>
              <GoatBotLinkedText text={part.source} environmentId={environmentId} />
            </MarkdownTableCopyOnCard>
            {index === last ? trail : null}
          </div>
        ) : (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
            key={index}
            className="goat-bot-prose goat-bot-card w-fit max-w-full min-w-0"
          >
            <GoatBotLinkedText text={part.source} environmentId={environmentId} />
            {index === last ? trail : null}
          </div>
        ),
      )}
    </div>
  );
}
