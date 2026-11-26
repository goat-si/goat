import { msg, useGT, useMessages } from "gt-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ScheduledTaskThreadMode, ThreadId } from "@goat/contracts";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { threadFamilies } from "../../state/threads";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Field } from "./ScheduledTaskNotificationPolicyField";

const THREAD_MODE_LABELS: Record<ScheduledTaskThreadMode, string> = {
  new_thread: msg("New thread each run"),
  continue: msg("One thread, continuing the conversation"),
  fresh_session: msg("One thread, fresh session each run"),
};

export function ScheduledTaskDestination({
  environmentId,
  threadId,
  threadMode: draftMode,
  onThreadModeChange,
  botRoutine,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly threadMode: ScheduledTaskThreadMode;
  /** Absent on servers that predate thread modes. */
  readonly onThreadModeChange: ((mode: ScheduledTaskThreadMode) => void) | undefined;
  readonly botRoutine: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  // A server without thread modes runs one thread exactly when the task has one.
  const threadMode: ScheduledTaskThreadMode = onThreadModeChange
    ? draftMode
    : threadId === null
      ? "new_thread"
      : "continue";
  const ref = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(ref);
  // The shell can omit older settled threads; their family read still carries the title.
  const family = useEnvironmentQuery(
    ref !== null && shell === null ? threadFamilies.familyAtom(environmentId, ref.threadId) : null,
  );
  const thread = shell ?? family.data?.threads.find((row) => row.id === threadId);
  const bound = ref !== null && threadMode !== "new_thread";
  const detail = botRoutine
    ? gt("Each run sends this prompt to GOAT Bot in this conversation.")
    : threadMode === "new_thread"
      ? gt("Each run starts a new thread with the workspace and model below.")
      : !bound
        ? threadMode === "continue"
          ? gt(
              "The first run starts a thread with the workspace and model below. Later runs continue that conversation.",
            )
          : gt(
              "The first run starts a thread with the workspace and model below. Later runs post there, each in a fresh session without earlier runs' context.",
            )
        : threadMode === "continue"
          ? gt("Each run continues this conversation, in its workspace and with its current model.")
          : gt("Each run starts a fresh session in this thread, without earlier runs' context.");
  return (
    <Field label={gt("Destination")} htmlFor="scheduled-task-destination">
      {onThreadModeChange && !botRoutine ? (
        <Select
          value={threadMode}
          onValueChange={(value) => onThreadModeChange(value as ScheduledTaskThreadMode)}
        >
          <SelectTrigger size="sm" id="scheduled-task-destination">
            <SelectValue>{m(THREAD_MODE_LABELS[threadMode])}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(THREAD_MODE_LABELS) as ScheduledTaskThreadMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {m(THREAD_MODE_LABELS[mode])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      <div className="space-y-1 text-sm">
        {bound ? (
          <p className="wrap-anywhere">
            {thread?.title.trim() || gt("Thread {id}", { id: ref.threadId })}
          </p>
        ) : null}
        <p className="text-muted-foreground">{detail}</p>
        {threadMode !== "new_thread" && !botRoutine ? (
          <p className="text-muted-foreground">
            {gt("Deleting the thread also deletes this task.")}
          </p>
        ) : null}
      </div>
    </Field>
  );
}

/** A GOAT Bot routine is answered with GOAT Bot's own model, so its stored one is not offered. */
export function ScheduledTaskBotModelField() {
  const gt = useGT();
  return (
    <Field label={gt("Model")}>
      <div className="space-y-1 text-sm">
        <p>{gt("GOAT Bot's model")}</p>
        <p className="text-muted-foreground">
          {gt(
            "This routine sends its prompt to GOAT Bot. GOAT Bot answers with its own model settings, so a model chosen here would not be used.",
          )}
        </p>
      </div>
    </Field>
  );
}
