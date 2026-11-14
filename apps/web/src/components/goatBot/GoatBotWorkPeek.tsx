import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { Link, useRouter } from "@tanstack/react-router";

import { ChevronLeftIcon } from "~/components/solar";

import { Button } from "../ui/button";
import { goatBotSearch, useGoatBotMember } from "./goatBotMemberContext";
import { GoatBotTaskTargetHidden } from "./goatBotTaskTargetContext";
import { GoatBotStepsContext } from "./GoatBotStepsLine";
import { GoatBotActivityContext, GoatBotTimeline } from "./GoatBotTimeline";
import { HoldsNavigation } from "~/lib/navigationHolds";
import { rememberHomeOrigin } from "./goatBotHomeRequest";
import { useAcknowledgeTaskRead } from "./useAcknowledgeTaskRead";
import type { GoatBotSourceIds } from "./useGoatBotSource";

const NO_RETRY = () => {};
// Focus moves to Back when the peek opens, as the row that opened it is gone.
const focusElement = (element: HTMLElement | null) => element?.focus();

/**
 * A task's conversation read inside the bot's panel, so the bot's own chat stays beside it. One
 * button opens the task's thread view, where its actions and worker live.
 */
export function GoatBotWorkPeek({
  taskId,
  title,
  statusLabel,
  rows,
  environmentId,
  unreadThrough = null,
  source,
  onAcknowledged,
  onRetry,
  onBack,
}: {
  readonly taskId: ChannelTaskId;
  readonly title: string;
  readonly statusLabel: string;
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly environmentId: EnvironmentId;
  /** The activity this task has not been read up to; null when nothing is unread. */
  readonly unreadThrough?: string | null | undefined;
  /** The chat's displayed-thread source, so history exposed later is not cued as new. */
  readonly source?: GoatBotSourceIds | undefined;
  /** Called once the acknowledgment lands, so the list stops showing its mark. */
  readonly onAcknowledged?: ((taskId: ChannelTaskId, readThrough: string) => void) | undefined;
  readonly onRetry?: ((clientKey: string) => void) | undefined;
  readonly onBack: () => void;
}) {
  const member = useGoatBotMember();
  const router = useRouter();
  // Opening a task acknowledges its activity, as its task view does.
  useAcknowledgeTaskRead({ environmentId, taskId, readThrough: unreadThrough, onAcknowledged });
  return (
    <section
      aria-label={title}
      className="flex min-h-0 min-w-0 flex-1 flex-col text-sm"
      onKeyDown={(event) => {
        // Escape steps back to Home before it would close the panel around it.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onBack();
      }}
    >
      <HoldsNavigation />
      <div className="flex min-w-0 flex-col items-start px-3 pt-14 pb-2">
        <Button
          ref={focusElement}
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label={"Back to Home from " + title}
          className="max-w-full min-w-0"
        >
          <ChevronLeftIcon aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{title}</span>
        </Button>
        <p className="px-3 text-xs text-muted-foreground">{statusLabel}</p>
      </div>
      {/* The chat's activity lines are the bot's, not this task's; the one way on is below. */}
      <GoatBotActivityContext value={null}>
        <GoatBotStepsContext value={null}>
          <GoatBotTaskTargetHidden value>
            {rows.length > 0 ? (
              <GoatBotTimeline
                key={`${source?.identity ?? ""}:${taskId}`}
                taskDetails
                rows={rows}
                baselineIds={source?.baselineIds}
                sourceIds={source?.sourceIds}
                environmentId={environmentId}
                onRetry={onRetry ?? NO_RETRY}
              />
            ) : (
              <p className="flex-1 px-4 text-muted-foreground">
                Nothing has been said in this task yet.
              </p>
            )}
          </GoatBotTaskTargetHidden>
        </GoatBotStepsContext>
      </GoatBotActivityContext>
      <div className="p-3">
        <Button
          className="w-full"
          render={
            <Link
              to="/bot"
              search={{ task: taskId, taskTitle: title, ...goatBotSearch(member) }}
              onClick={(event) => {
                if (
                  !event.defaultPrevented &&
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                )
                  rememberHomeOrigin(router, environmentId, member?.botId ?? null, taskId);
              }}
            />
          }
        >
          Go to thread
        </Button>
      </div>
    </section>
  );
}
