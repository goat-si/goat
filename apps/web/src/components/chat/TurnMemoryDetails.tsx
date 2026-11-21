import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, RunId, ThreadId } from "@goat/contracts";
import * as Option from "effect/Option";
import { use, useState } from "react";
import { useGT } from "gt-react";
import { memoryEnvironment } from "../../state/memory";

import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";

export function UserMessageTurnMemory({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const { threadRef } = use(TimelineRowCtx);
  const { runId, inputIntent } = row.message;
  if (!threadRef || !runId || inputIntent === "steer" || inputIntent === "promoted_queued_to_steer")
    return null;
  return (
    <TurnMemoryDetails
      environmentId={threadRef.environmentId}
      threadId={row.projectedItem?.item.threadId ?? threadRef.threadId}
      runId={runId}
    />
  );
}

type Target = { environmentId: EnvironmentId; threadId: ThreadId; runId: RunId };

export function TurnMemoryDetails(target: Target) {
  const allowed = useAtomValue(memoryEnvironment.canInspectTurnMemory(target.environmentId));
  return allowed ? <Disclosure key={JSON.stringify(target)} {...target} /> : null;
}

function Disclosure(target: Target) {
  const [open, setOpen] = useState(false);
  const gt = useGT();
  return (
    <div className="ml-auto w-fit max-w-full text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        className="ml-auto block hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {gt("Turn memory")}
      </button>
      {open ? <Receipts {...target} /> : null}
    </div>
  );
}

function Receipts({ environmentId, threadId, runId }: Target) {
  const gt = useGT();
  const result = useAtomValue(
    memoryEnvironment.turnMemoryForRun({ environmentId, input: { threadId, runId } }),
  );
  if (result === null) return <p>{gt("Loading turn memory…")}</p>;
  if (Option.isNone(result)) return <p>{gt("Turn memory is unavailable.")}</p>;
  if (!result.value.events.length)
    return <p>{gt("No memory activity was recorded for this turn.")}</p>;
  return (
    <div className="mt-1 space-y-2 rounded-md border p-3 wrap-anywhere">
      {result.value.events.map((event) => (
        <section key={event.id}>
          <strong>
            {event.kind === "automatic" ? gt("Provided to the model") : gt("Memory recall")}
          </strong>
          {event.query && (
            <p>
              {gt("Query")}: {event.query}
            </p>
          )}
          {event.items.length === 0 && <p>{gt("No visible entries.")}</p>}
          {event.items.map((item) => (
            <div key={item.memoryId}>
              {item.excerpt && <p>{item.excerpt}</p>}
              <code>
                {item.memoryId} · {gt("Revision")} {item.revisionId}
              </code>
            </div>
          ))}
        </section>
      ))}
      {result.value.truncated && <p>{gt("Only the first recorded events are shown.")}</p>}
    </div>
  );
}
