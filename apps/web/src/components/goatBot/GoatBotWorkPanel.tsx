import { groupBotWork, presentTaskStatus } from "@goat/client-runtime/goatBot";
import type { BotThreadRow, EnvironmentId, ThreadId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { GoatBotRoutines } from "./GoatBotRoutines";
import { GoatBotWorkDetails } from "./GoatBotWorkDetails";
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
  const work = groupBotWork(rows, [], environmentId);
  const tasks = [...work.inProgress, ...work.done];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4 text-sm">
      <Tabs value={tab} onValueChange={(value: Tab) => setTab(value)} className="min-h-0 flex-1">
        <div className="pr-10">
          <TabsList aria-label="GOAT Bot work">
            {tabs.map((name) => (
              <TabsTab key={name} value={name}>
                {name}
              </TabsTab>
            ))}
          </TabsList>
        </div>
        <TabsPanel value="Tasks" className="mt-4 min-h-0 overflow-y-auto">
          {tasks.length === 0 ? (
            <p>No task threads yet. Ask GOAT Bot to start work.</p>
          ) : (
            <div className="space-y-4">
              {([false, true] as const).map((done) => (
                <section key={String(done)}>
                  <h3 className="font-semibold">{done ? "Done" : "In progress"}</h3>
                  {(done ? work.done : work.inProgress).map(({ row }) => (
                    <TaskWorkRow
                      key={row.task.taskId}
                      row={row}
                      rows={rows}
                      environmentId={environmentId}
                    />
                  ))}
                </section>
              ))}
            </div>
          )}
        </TabsPanel>
        <TabsPanel value="Routines" className="mt-4 min-h-0 overflow-y-auto">
          <GoatBotRoutines
            environmentId={environmentId}
            threadId={threadId}
            tasks={routines.data?.tasks ?? []}
            error={routines.error}
          />
        </TabsPanel>
        <TabsPanel value="Library" className="mt-4">
          <p>Files GOAT Bot saves will appear here.</p>
        </TabsPanel>
        <TabsPanel value="Computer" className="mt-4">
          <p>Machines GOAT Bot works on will appear here.</p>
        </TabsPanel>
      </Tabs>
    </div>
  );
}

function TaskWorkRow({
  row,
  rows,
  environmentId,
}: {
  row: Extract<BotThreadRow, { kind: "task" }>;
  rows: readonly BotThreadRow[];
  environmentId: EnvironmentId;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="py-1">
      <Link
        to="/bot"
        search={{ task: row.task.taskId }}
        className="block rounded-md p-2 hover:bg-accent"
      >
        {row.task.title}
        <span className="block text-xs text-muted-foreground">
          {presentTaskStatus(row.task.status, row.view.doneAt).label}
        </span>
      </Link>
      <button
        type="button"
        className="px-2 text-xs text-muted-foreground"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Hide work" : "Show work"}
      </button>
      {expanded && (
        <GoatBotWorkDetails environmentId={environmentId} taskId={row.task.taskId} rows={rows} />
      )}
    </div>
  );
}
