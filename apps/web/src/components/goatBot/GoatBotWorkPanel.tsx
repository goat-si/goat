import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useBotRoster } from "./useBotRoster";

const tabs = ["Tasks", "Routines", "Library", "Computer"] as const;
type Tab = (typeof tabs)[number];

export function GoatBotWorkPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [tab, setTab] = useState<Tab>("Tasks");
  const { rows } = useBotRoster();
  const routines = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const tasks = rows.filter((row) => row.kind === "task");
  const boundRoutines = (routines.data?.tasks ?? []).filter(
    (routine) => routine.threadId === threadId,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div role="tablist" aria-label="GOAT Bot work" className="flex flex-wrap gap-2">
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className="rounded-md px-2 py-1 text-sm aria-selected:bg-accent"
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 overflow-y-auto py-4 text-sm">
        {tab === "Tasks" &&
          (tasks.length === 0 ? (
            <p>No task threads yet.</p>
          ) : (
            <div className="space-y-4">
              {([false, true] as const).map((done) => (
                <section key={String(done)}>
                  <h3 className="font-semibold">{done ? "Done" : "In progress"}</h3>
                  {tasks
                    .filter((row) => Boolean(row.view.doneAt) === done)
                    .map((row) => (
                      <Link
                        key={row.task.taskId}
                        to="/bot"
                        search={{ task: row.task.taskId }}
                        className="block rounded-md p-2 hover:bg-accent"
                      >
                        {row.task.title}
                      </Link>
                    ))}
                </section>
              ))}
            </div>
          ))}
        {tab === "Routines" &&
          (boundRoutines.length ? (
            boundRoutines.map((routine) => (
              <p key={routine.id} className="py-1">
                {routine.title}
              </p>
            ))
          ) : (
            <p>Ask GOAT Bot in chat to set up a routine.</p>
          ))}
        {tab === "Library" && <p>Files GOAT Bot saves will appear here.</p>}
        {tab === "Computer" && <p>Machines GOAT Bot works on will appear here.</p>}
      </div>
    </div>
  );
}
