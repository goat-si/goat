import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type { ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";

import { ChevronLeftIcon } from "~/components/solar";

import { Button } from "../ui/button";
import { goatBotSearch, useGoatBotMember } from "./goatBotMemberContext";
import { GoatBotActivityContext, GoatBotTimeline } from "./GoatBotTimeline";

const NO_RETRY = () => {};
// Focus moves to Back when the peek opens, as the row that opened it is gone.
const focusElement = (element: HTMLElement | null) => element?.focus();

/**
 * A task's conversation read inside the bot's panel, so the bot's own chat stays beside it. One
 * button opens the thread: the task's worker thread when it runs here, else the task's own view.
 */
export function GoatBotWorkPeek({
  taskId,
  title,
  statusLabel,
  worker,
  rows,
  environmentId,
  onRetry,
  onBack,
}: {
  readonly taskId: ChannelTaskId;
  readonly title: string;
  readonly statusLabel: string;
  readonly worker: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly environmentId: EnvironmentId;
  readonly onRetry?: ((clientKey: string) => void) | undefined;
  readonly onBack: () => void;
}) {
  const member = useGoatBotMember();
  // The task's card would add a second way to the thread; its status sits under the title.
  const conversation = rows.filter((row) => row.kind !== "task");
  return (
    <section aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col text-sm">
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
      {/* The chat's activity line is the bot's, not this task's. */}
      <GoatBotActivityContext value={null}>
        {conversation.length > 0 ? (
          <GoatBotTimeline
            taskDetails
            rows={conversation}
            environmentId={environmentId}
            onRetry={onRetry ?? NO_RETRY}
          />
        ) : (
          <p className="flex-1 px-4 text-muted-foreground">
            Nothing has been said in this task yet.
          </p>
        )}
      </GoatBotActivityContext>
      <div className="p-3">
        <Button
          className="w-full"
          render={
            worker === null ? (
              <Link to="/bot" search={{ task: taskId, ...goatBotSearch(member) }} />
            ) : (
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: worker.environmentId, threadId: worker.threadId }}
              />
            )
          }
        >
          Go to thread
        </Button>
      </div>
    </section>
  );
}
