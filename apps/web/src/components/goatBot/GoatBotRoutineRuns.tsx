import { Toolbar } from "@base-ui/react/toolbar";
import {
  botRoutineRuns,
  routineRunFinished,
  routineRunState,
  routineRunTime,
  type BotRoutineSource,
  type RoutineRunDot,
  type RoutineRunShape,
} from "@goat/client-runtime/scheduledTasks";
import type { ChannelInputSnapshot, EnvironmentId, ThreadId } from "@goat/contracts";
import { useContext, useState } from "react";
import { usePrimarySettings } from "~/hooks/useSettings";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import { timestampLocale } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { GoatBotChatHidden } from "./goatBotLayout";

const RUNS_SHOWN = 7;
const NO_DETAILS = "Details for this run aren't available.";

type RunTask = Pick<BotRoutineSource, "recentRuns" | "lastRun" | "lastRunError">;
type TimeOptions = Parameters<typeof routineRunFinished>[2];

/** Run times in web's timestamp locale, with the hours the Timestamp format setting picks. */
function useRunTimeOptions(): TimeOptions {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  return {
    ...(timestampLocale === undefined ? {} : { locale: timestampLocale }),
    ...(timestampFormat === "locale" ? {} : { hour12: timestampFormat === "12-hour" }),
  };
}

/** A task hiding the chat closes a docked Home's run; Home's sheet stays on screen over the task. */
function useRunPopoverOpen(docked: boolean) {
  const hidden = useContext(GoatBotChatHidden);
  const [openId, setOpenId] = useState<RoutineRunDot["firingId"] | null>(null);
  const closed = hidden && docked;
  if (closed && openId !== null) setOpenId(null);
  return [closed ? null : openId, setOpenId] as const;
}

/** A routine's recent runs as dots, oldest first; each opens what that run said. */
export function GoatBotRoutineRuns(props: {
  readonly environmentId: EnvironmentId;
  readonly botThreadId: ThreadId;
  readonly task: RunTask;
  readonly title: string;
  readonly botName: string;
  readonly docked: boolean;
  readonly showRunInChat?: ((inputId: string) => (() => void) | undefined) | undefined;
}) {
  const timeOptions = useRunTimeOptions();
  const [openId, setOpenId] = useRunPopoverOpen(props.docked);
  // Show in chat focuses the reply itself, so that run's close gives no focus back to its dot. A
  // boolean keeps Base UI's own rule of returning focus only when it is still in the popup.
  const [toChatId, setToChatId] = useState<RoutineRunDot["firingId"] | null>(null);
  const dots = botRoutineRuns(props.task, RUNS_SHOWN, (iso) => routineRunTime(iso, timeOptions));
  if (dots.length === 0) return null;
  // A run pushed out of the seven closes its popover.
  const open = dots.find((dot) => dot.firingId === openId);
  const conversation = open?.conversation;
  const show =
    conversation !== undefined && conversation.threadId === props.botThreadId
      ? props.showRunInChat?.(conversation.inputId)
      : undefined;
  const showInChat =
    show === undefined
      ? undefined
      : () => {
          setToChatId(open?.firingId ?? null);
          setOpenId(null);
          show();
        };
  return (
    <Toolbar.Root aria-label={`Recent runs of ${props.title}`} className="-ms-2 flex flex-wrap">
      {dots.map((dot) => (
        <Popover
          key={dot.firingId}
          open={dot === open}
          onOpenChange={(next) => {
            if (next) setToChatId(null);
            setOpenId((current) =>
              next ? dot.firingId : current === dot.firingId ? null : current,
            );
          }}
        >
          <PopoverTrigger
            render={
              <Toolbar.Button
                aria-label={dot.accessibleName}
                className="flex size-7 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-accent"
              />
            }
          >
            <RunShape shape={dot.shape} />
          </PopoverTrigger>
          <PopoverPopup width="md" align="start" finalFocus={dot.firingId !== toChatId}>
            <RunDetails
              environmentId={props.environmentId}
              dot={dot}
              newest={dot === dots.at(-1)}
              task={props.task}
              botName={props.botName}
              timeOptions={timeOptions}
              onShowInChat={dot === open ? showInChat : undefined}
            />
          </PopoverPopup>
        </Popover>
      ))}
    </Toolbar.Root>
  );
}

function RunShape(props: { readonly shape: RoutineRunShape }) {
  switch (props.shape) {
    case "filled-circle":
      return <span aria-hidden className="size-2.5 rounded-full bg-success-foreground" />;
    case "bar":
      return <span aria-hidden className="h-1 w-2.5 rounded-xs bg-muted-foreground" />;
    case "filled-square":
      return <span aria-hidden className="size-2.5 bg-destructive" />;
    case "hollow-diamond":
      return <span aria-hidden className="size-2 rotate-45 border border-muted-foreground" />;
    case "hollow-square":
      return <span aria-hidden className="size-2.5 border border-muted-foreground" />;
  }
}

/** Mounted only while its popover is open, so a closed dot reads nothing. */
function RunDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly dot: RoutineRunDot;
  readonly newest: boolean;
  readonly task: RunTask;
  readonly botName: string;
  readonly timeOptions: TimeOptions;
  readonly onShowInChat: (() => void) | undefined;
}) {
  const { dot } = props;
  const state = routineRunState(dot);
  const inputId = dot.conversation?.inputId;
  const quiet = dot.quiet === true && dot.status === "completed";
  // Only an ended run that reached the bot is read; one still going reads once the list says so.
  const readable = state === "ended" && !quiet && dot.dispatchFailed !== true;
  const read = useEnvironmentQuery(
    readable && inputId !== undefined
      ? channelEnvironment.getInput({ environmentId: props.environmentId, input: { inputId } })
      : null,
  );
  const word = dot.word.charAt(0).toUpperCase() + dot.word.slice(1);
  const finished = routineRunFinished(dot.requestedAt, dot.completedAt, props.timeOptions);
  return (
    <div className="flex flex-col gap-2">
      <PopoverTitle>
        {word} · {routineRunTime(dot.requestedAt, props.timeOptions)}
        {finished === null ? "" : `, ${finished}`}
      </PopoverTitle>
      <p className="line-clamp-6 text-sm whitespace-pre-line text-muted-foreground">
        {runBody({ ...props, state, quiet, inputId, read })}
      </p>
      {props.onShowInChat === undefined ? null : (
        <div className="flex justify-end">
          <Button size="xs" variant="outline" onClick={props.onShowInChat}>
            Show in chat
          </Button>
        </div>
      )}
    </div>
  );
}

/** The same cases, in the same order and words, as mobile's run panel. */
function runBody(input: {
  readonly dot: RoutineRunDot;
  readonly newest: boolean;
  readonly task: RunTask;
  readonly botName: string;
  readonly state: ReturnType<typeof routineRunState>;
  readonly quiet: boolean;
  readonly inputId: string | undefined;
  readonly read: { readonly data: ChannelInputSnapshot | null; readonly error: string | null };
}): string {
  const { dot } = input;
  if (input.state === "in-flight") return "Still running.";
  if (input.quiet) return "No update";
  if (dot.dispatchFailed === true) {
    const error =
      input.newest && input.task.lastRun?.firingId === dot.firingId
        ? input.task.lastRunError?.split("\n")[0]?.trim()
        : undefined;
    return error !== undefined && error !== "" ? error : `This run didn't reach ${input.botName}.`;
  }
  if (input.state === "unsettled" || input.inputId === undefined) return NO_DETAILS;
  if (input.read.error !== null) return "Couldn't load this run.";
  const snapshot = input.read.data;
  if (snapshot === null) return "Loading…";
  return snapshot.reply?.text ?? snapshot.failure?.message ?? NO_DETAILS;
}
