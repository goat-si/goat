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
import { GoatBotPanelEmpty } from "./GoatBotPanelEmpty";

export function GoatBotRoutines(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: readonly BotRoutineSource[];
  readonly error: string | null;
}) {
  const nowMinute = useNowMinute();
  const botName = useGoatBotName();
  const rows = botRoutineRows(props.tasks, props.threadId, Date.parse(`${nowMinute}:00.000Z`));
  if (props.error !== null) return <p className="text-destructive">Couldn't load routines.</p>;
  return (
    <div className="space-y-3">
      {findCheckInRoutine(props.tasks, props.threadId) === undefined ? (
        <CheckInOffer environmentId={props.environmentId} threadId={props.threadId} />
      ) : null}
      {rows.length === 0 ? (
        <GoatBotPanelEmpty
          title="No routines yet"
          next={`Ask ${botName} in chat to set up a routine.`}
        />
      ) : (
        <ul className="m-0 list-none space-y-1 p-0">
          {rows.map((row) => (
            <RoutineRow key={row.id} environmentId={props.environmentId} row={row} />
          ))}
        </ul>
      )}
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
  if (open) return <GoatBotCheckInForm {...props} onClose={() => setOpen(false)} />;
  return (
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
      Check in on me
    </Button>
  );
}

function RoutineRow({ environmentId, row }: { environmentId: EnvironmentId; row: BotRoutineRow }) {
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
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <li className="rounded-md p-2 hover:bg-accent">
      <div className="flex items-center gap-3">
        <Link
          to="/settings/scheduled-tasks"
          search={{ environmentId, taskId: row.id }}
          className="min-w-0 flex-1"
        >
          <span className="block truncate font-medium">{row.title}</span>
          <span className="block text-xs text-muted-foreground">
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
      {error !== null ? (
        <p role="alert" className="pt-1 text-xs text-destructive">
          Couldn't {row.enabled ? "pause" : "resume"} this routine: {error}
        </p>
      ) : null}
      {runError !== null ? (
        <p role="alert" className="pt-1 text-xs text-destructive">
          Couldn't run this routine: {runError}
        </p>
      ) : null}
    </li>
  );
}
