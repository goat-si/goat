import type { GoatBotAvailability, GoatBotRemoval } from "@goat/client-runtime/goatBot";
import { Link } from "@tanstack/react-router";

import { GOAT_BOT_PATH } from "~/globalAgentRoute";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { GoatBotAvatar } from "./GoatBotAvatar";
import { useGoatBotName, useGoatBotPicture } from "./goatBotMemberContext";

/** In place of a chat that was archived, deleted or could not be checked. */
export function GoatBotRemovedNotice({
  removal,
  availability,
  onRetryAvailability,
  canOpenCurrentBot,
  onUnarchive,
  onRestore,
  memberName,
  onCheckAgain,
}: {
  readonly removal: Exclude<GoatBotRemoval, null>;
  readonly availability: GoatBotAvailability;
  readonly onRetryAvailability: (() => void) | undefined;
  readonly canOpenCurrentBot: boolean;
  readonly onUnarchive: (() => void) | undefined;
  readonly onRestore: (() => void) | undefined;
  readonly memberName: string | null;
  readonly onCheckAgain: (() => void) | undefined;
}) {
  const picture = useGoatBotPicture();
  const botName = useGoatBotName();
  if (memberName !== null) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader className="max-w-md">
          <GoatBotAvatar
            size="lg"
            emoji={picture.emoji}
            accent={picture.accent}
            className="mx-auto mb-4"
          />
          <EmptyTitle>{memberName} was deleted</EmptyTitle>
          <EmptyDescription>
            Its conversation is archived. Restore it to keep chatting here.
          </EmptyDescription>
        </EmptyHeader>
        {onRestore !== undefined ? (
          <EmptyContent>
            <div className="flex justify-center">
              <Button size="sm" variant="outline" onClick={onRestore}>
                Restore
              </Button>
            </div>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }
  if (removal === "unchecked") {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader className="max-w-md">
          <GoatBotAvatar
            size="lg"
            emoji={picture.emoji}
            accent={picture.accent}
            className="mx-auto mb-4"
          />
          <EmptyTitle>Couldn't check this chat</EmptyTitle>
          <EmptyDescription>
            It may have been archived or deleted. Check again to find out.
          </EmptyDescription>
        </EmptyHeader>
        {onCheckAgain !== undefined ? (
          <EmptyContent>
            <div className="flex justify-center">
              <Button size="sm" variant="outline" onClick={onCheckAgain}>
                Check again
              </Button>
            </div>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }
  const replacementFailed =
    removal === "deleted" &&
    !canOpenCurrentBot &&
    (availability.kind === "error" ||
      availability.kind === "legacy_active" ||
      availability.kind === "ready");
  const description = canOpenCurrentBot
    ? `${botName} keeps going in its current chat.`
    : removal === "archived"
      ? `Unarchive it to keep chatting with ${botName} here.`
      : replacementFailed
        ? `Couldn't start a new ${botName} chat.`
        : availability.kind === "connecting"
          ? `${botName} is starting a new chat.`
          : `Reconnect to start a new ${botName} chat.`;
  return (
    <Empty className="min-h-0 flex-1">
      <EmptyHeader className="max-w-md">
        <GoatBotAvatar
          size="lg"
          emoji={picture.emoji}
          accent={picture.accent}
          className="mx-auto mb-4"
        />
        <EmptyTitle>
          {removal === "archived" ? "This chat is archived" : "This chat was deleted"}
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {canOpenCurrentBot ||
      onUnarchive !== undefined ||
      (replacementFailed && onRetryAvailability) ? (
        <EmptyContent>
          <div className="flex justify-center">
            {canOpenCurrentBot ? (
              <Button size="sm" variant="outline" render={<Link to={GOAT_BOT_PATH} />}>
                Open GOAT Bot
              </Button>
            ) : onUnarchive !== undefined ? (
              <Button size="sm" variant="outline" onClick={onUnarchive}>
                Unarchive
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onRetryAvailability}>
                Try again
              </Button>
            )}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
