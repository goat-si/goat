import { useAtomValue } from "@effect/atom-react";
import {
  botRoutineRows,
  findCheckInRoutine,
  type BotRoutineRow,
  type BotRoutineSource,
} from "@goat/client-runtime/scheduledTasks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { GoatBotCheckInForm } from "./GoatBotCheckInForm";
import { useGoatBotName } from "./goatBotMemberContext";
import { GoatBotPanelEmpty, GoatBotPanelFailure } from "./GoatBotPanelEmpty";
import { GoatBotCardRow, GoatBotCardSkeleton, GoatBotShowMoreRow } from "./GoatBotSectionCard";

/** What New routine puts in the message box: the person finishes the sentence. */
const NEW_ROUTINE_DRAFT = "Set up a routine: ";
/** Routines past this many rows wait behind Show more. */
const COLLAPSED_ROUTINES = 5;

/** The section's one trailing action: a routine request in the chat's message box. */
export function GoatBotNewRoutineButton({
  onDraft,
}: {
  readonly onDraft?: ((text: string) => void) | undefined;
}) {
  if (onDraft === undefined) return null;
  return (
    <Button variant="ghost" size="xs" onClick={() => onDraft(NEW_ROUTINE_DRAFT)}>
      New routine
    </Button>
  );
}

export function GoatBotRoutines(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Null until the first read answers; a failed read later keeps the last list. */
  readonly tasks: readonly BotRoutineSource[] | null;
  readonly error: string | null;
  readonly failure?: unknown;
  readonly offline?: boolean | undefined;
  readonly onRetry: () => void;
  /** Starts a routine request in the chat's message box; absent while the chat cannot send. */
  readonly onDraft?: ((text: string) => void) | undefined;
  /** The routine whose row scrolls into view and takes focus when it shows. */
  readonly focusRoutineId?: string | null | undefined;
  readonly onRoutineFocused?: (() => void) | undefined;
  /** Whether that row may still take focus when it shows, or the person has moved on. */
  readonly routineMayFocus?: (() => boolean) | undefined;
}) {
  const nowMinute = useNowMinute();
  const botName = useGoatBotName();
  const [showAll, setShowAll] = useState(false);
  // A chip naming a routine behind Show more opens the list first, so its row exists to land on.
  const landingHidden =
    props.focusRoutineId !== null &&
    props.focusRoutineId !== undefined &&
    props.tasks !== null &&
    !showAll &&
    botRoutineRows(props.tasks, props.threadId, Date.parse(`${nowMinute}:00.000Z`))
      .slice(COLLAPSED_ROUTINES)
      .some((row) => row.id === props.focusRoutineId);
  if (landingHidden) setShowAll(true);
  const denied =
    typeof props.failure === "object" &&
    props.failure !== null &&
    "_tag" in props.failure &&
    props.failure._tag === "EnvironmentAuthorizationError";
  const failure = props.offline ? (
    <GoatBotPanelFailure
      message={`Routines are unavailable while ${botName}'s computer is offline.`}
    />
  ) : denied ? (
    <GoatBotPanelFailure message={`This device can't read ${botName}'s routines.`} />
  ) : props.error === null ? null : (
    <GoatBotPanelFailure message="Couldn't load routines." onRetry={props.onRetry} />
  );
  if (props.tasks === null)
    return (
      <div>
        {failure === null ? (
          <>
            <p className="sr-only">Loading routines…</p>
            <GoatBotCardSkeleton rows={2} />
          </>
        ) : (
          <div className="px-3 py-3">{failure}</div>
        )}
      </div>
    );
  const rows = botRoutineRows(props.tasks, props.threadId, Date.parse(`${nowMinute}:00.000Z`));
  const offerCheckIn =
    failure === null && findCheckInRoutine(props.tasks, props.threadId) === undefined;
  const hidden = rows.length - COLLAPSED_ROUTINES;
  const shown = showAll ? rows : rows.slice(0, COLLAPSED_ROUTINES);
  return (
    <div className="flex flex-col">
      {failure === null ? null : <div className="px-3 py-3">{failure}</div>}
      {offerCheckIn ? (
        <CheckInOffer environmentId={props.environmentId} threadId={props.threadId} />
      ) : null}
      {rows.length === 0 && failure === null ? (
        <div className="px-3 py-3">
          <GoatBotPanelEmpty
            title="No routines yet"
            next={
              props.onDraft === undefined
                ? `Ask ${botName} in chat to set up a routine.`
                : `Ask ${botName} in chat to set up a routine, or start with New routine.`
            }
          />
        </div>
      ) : null}
      {shown.map((row) => (
        <RoutineRow
          key={row.id}
          environmentId={props.environmentId}
          row={row}
          onFocused={row.id === props.focusRoutineId ? props.onRoutineFocused : undefined}
          mayFocus={props.routineMayFocus}
        />
      ))}
      {hidden > 0 ? (
        <GoatBotShowMoreRow expanded={showAll} onToggle={() => setShowAll((value) => !value)} />
      ) : null}
    </div>
  );
}

function CheckInOffer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canCreate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(props.environmentId),
  );
  const [open, setOpen] = useState(false);
  if (!canCreate) return null;
  if (open)
    return (
      <div className="border-b border-border/50 px-3 py-2">
        <GoatBotCheckInForm {...props} onClose={() => setOpen(false)} />
      </div>
    );
  return (
    <GoatBotCardRow
      mark={<span aria-hidden className="size-2 rounded-full border border-current" />}
      title="Check in on me"
      detail="A routine on the days and hours you choose"
      ariaLabel="Check in on me"
      onOpen={() => setOpen(true)}
      chevron
    />
  );
}

function RoutineRow({
  environmentId,
  row,
  onFocused,
  mayFocus,
}: {
  environmentId: EnvironmentId;
  row: BotRoutineRow;
  /** Present while this row should take focus; called once it has, or once it may not. */
  onFocused?: (() => void) | undefined;
  mayFocus?: (() => boolean) | undefined;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskEnabled.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "GOAT Bot routine enabled",
    reportFailure: false,
  });
  const canRunNow = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId),
  );
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "GOAT Bot routine run now",
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const runAgain = async () => {
    if (running) return;
    setRunning(true);
    setRunError(null);
    const result = await runNow({ environmentId, input: { id: row.id } });
    setRunning(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setRunError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const toggle = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await setEnabled({ environmentId, input: { id: row.id, enabled } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      tentative(failure);
    }
  };
  const tentative = (failure: unknown) => {
    setError(failure instanceof Error ? failure.message : String(failure));
  };
  const focusRow = (element: HTMLAnchorElement | null) => {
    if (element === null) return;
    if (mayFocus === undefined || mayFocus()) {
      element.scrollIntoView({ block: "nearest" });
      element.focus({ preventScroll: true });
    }
    onFocused?.();
  };
  return (
    <div className="border-t border-border/50 px-3 py-2 first:border-t-0">
      <div className="flex min-h-9 items-center gap-2.5">
        <Link
          to="/settings/scheduled-tasks"
          search={{ environmentId, taskId: row.id }}
          className="min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          ref={onFocused === undefined ? undefined : focusRow}
        >
          <span className="block truncate">{row.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {row.scheduleText} · {row.nextText}
          </span>
          <span
            className={cn(
              "block truncate text-xs",
              row.lastFailed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {row.lastText}
          </span>
        </Link>
        {row.lastFailed && canRunNow ? (
          <Button size="xs" variant="outline" disabled={running} onClick={() => void runAgain()}>
            Run now
          </Button>
        ) : null}
        <Switch
          checked={row.enabled}
          disabled={busy || !canOperate}
          aria-label={`${row.enabled ? "Pause" : "Resume"} ${row.title}`}
          onCheckedChange={(enabled) => void toggle(enabled)}
        />
      </div>
      {error === null ? null : (
        <p role="alert" className="pt-1 text-xs text-destructive">
          Couldn't {row.enabled ? "pause" : "resume"} this routine: {error}
        </p>
      )}
      {runError === null ? null : (
        <p role="alert" className="pt-1 text-xs text-destructive">
          Couldn't run this routine: {runError}
        </p>
      )}
    </div>
  );
}
