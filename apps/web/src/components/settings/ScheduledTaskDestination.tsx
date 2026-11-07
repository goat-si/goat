import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { threadFamilies } from "../../state/threads";
import { Field } from "./ScheduledTaskNotificationPolicyField";

export function ScheduledTaskDestination({
  environmentId,
  threadId,
  botRoutine,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly botRoutine: boolean;
}) {
  const ref = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(ref);
  // The shell can omit older settled threads; their family read still carries the title.
  const family = useEnvironmentQuery(
    ref !== null && shell === null ? threadFamilies.familyAtom(environmentId, ref.threadId) : null,
  );
  const thread = shell ?? family.data?.threads.find((row) => row.id === threadId);
  return (
    <Field label="Destination">
      {ref === null ? (
        <p className="text-sm text-muted-foreground">
          Each run starts a new thread with the workspace and model below.
        </p>
      ) : (
        <div className="space-y-1 text-sm">
          <p className="wrap-anywhere">{thread?.title.trim() || `Thread ${ref.threadId}`}</p>
          <p className="text-muted-foreground">
            {botRoutine
              ? "Each run sends this prompt to GOAT Bot in this conversation."
              : "Each run continues this conversation, in its workspace and with its current model."}
          </p>
        </div>
      )}
    </Field>
  );
}

/** A GOAT Bot routine is answered with GOAT Bot's own model, so its stored one is not offered. */
export function ScheduledTaskBotModelField() {
  return (
    <Field label="Model">
      <div className="space-y-1 text-sm">
        <p>GOAT Bot&apos;s model</p>
        <p className="text-muted-foreground">
          This routine sends its prompt to GOAT Bot. GOAT Bot answers with its own model settings,
          so a model chosen here would not be used.
        </p>
      </div>
    </Field>
  );
}
