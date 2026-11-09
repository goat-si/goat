import {
  goatBotTurnsOutsideList,
  goatBotWaitingInChatText,
  groupBotWork,
  presentTaskStatus,
} from "@goat/client-runtime/goatBot";
import type { BotRemoteWork, BotThreadRow, EnvironmentId, ThreadId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { GoatBotRoutines } from "./GoatBotRoutines";
import { GoatBotComputer } from "./GoatBotComputer";
import { GoatBotLibrary } from "./GoatBotLibrary";
import { GoatBotMemory } from "./GoatBotMemory";
import { GoatBotStatusCard } from "./GoatBotStatusCard";
import { GoatBotWorkDetails } from "./GoatBotWorkDetails";
import {
  goatBotSearch,
  memberThreadsKey,
  useGoatBotMember,
  useGoatBotName,
} from "./goatBotMemberContext";
import { useBotThreads } from "./useBotRoster";

const tabs = ["Tasks", "Routines", "Memory", "Library", "Computer"] as const;
type Tab = (typeof tabs)[number];

export function GoatBotWorkPanel({
  environmentId,
  threadId,
  onDraft,
  notesRefreshKey,
  onShowChat,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Called when a link leads back to the chat, so a sheet over it can close. */
  onShowChat?: (() => void) | undefined;
  /** Puts a message in this chat's composer; absent while the chat cannot send. */
  onDraft?: ((text: string) => void) | undefined;
  notesRefreshKey?: string | undefined;
}) {
  const [tab, setTab] = useState<Tab>("Tasks");
  const member = useGoatBotMember();
  const botName = useGoatBotName();
  const { rows, remoteWork, supported, loaded, failed, turnsWaiting } = useBotThreads(
    environmentId,
    memberThreadsKey(member),
  );
  const routines = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const work = groupBotWork(rows, [], environmentId);
  const tasks = [...work.inProgress, ...work.done];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4 text-sm">
      <Tabs value={tab} onValueChange={(value: Tab) => setTab(value)} className="min-h-0 flex-1">
        <div className="pr-10">
          {/* Five tabs do not fit the panel at equal widths, so each keeps its label and the row wraps. */}
          <TabsList aria-label={`${botName} work`} className="flex-wrap">
            {tabs.map((name) => (
              <TabsTab key={name} value={name} className="flex-none">
                {name}
              </TabsTab>
            ))}
          </TabsList>
        </div>
        <GoatBotStatusCard
          className="mt-4 rounded-lg border border-border p-3"
          environmentId={environmentId}
          member={member}
          rows={!supported ? "unavailable" : failed ? "failed" : loaded ? rows : null}
          turnsWaiting={turnsWaiting}
          onShowChat={onShowChat}
        />
        <TabsPanel value="Tasks" className="mt-4 min-h-0 overflow-y-auto">
          {goatBotTurnsOutsideList(turnsWaiting, rows).length > 0 ? (
            <p className="mb-3">
              {goatBotWaitingInChatText(botName)}.{" "}
              <Link
                to="/bot"
                search={goatBotSearch(member)}
                onClick={onShowChat}
                className="underline"
              >
                Open the chat
              </Link>
            </p>
          ) : null}
          {tasks.length === 0 ? (
            <p>No task threads yet. Ask {botName} to start work.</p>
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
                      remoteWork={remoteWork}
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
        <TabsPanel value="Memory" className="mt-4 min-h-0 overflow-y-auto">
          <GoatBotMemory
            environmentId={environmentId}
            onDraft={onDraft}
            refreshKey={notesRefreshKey}
          />
        </TabsPanel>
        <TabsPanel value="Library" className="mt-4 min-h-0 overflow-y-auto">
          <GoatBotLibrary environmentId={environmentId} />
        </TabsPanel>
        <TabsPanel value="Computer" className="mt-4 min-h-0 overflow-y-auto">
          <GoatBotComputer environmentId={environmentId} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

function TaskWorkRow({
  row,
  rows,
  remoteWork,
  environmentId,
}: {
  row: Extract<BotThreadRow, { kind: "task" }>;
  rows: readonly BotThreadRow[];
  remoteWork: readonly BotRemoteWork[];
  environmentId: EnvironmentId;
}) {
  const [expanded, setExpanded] = useState(false);
  const member = useGoatBotMember();
  return (
    <div className="py-1">
      <Link
        to="/bot"
        search={{ task: row.task.taskId, ...goatBotSearch(member) }}
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
        <GoatBotWorkDetails
          environmentId={environmentId}
          taskId={row.task.taskId}
          rows={rows}
          remoteWork={remoteWork}
        />
      )}
    </div>
  );
}
