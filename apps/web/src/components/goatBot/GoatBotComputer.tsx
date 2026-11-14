import {
  BOT_RUNNING_TASK_STATUSES,
  botComputers,
  goatBotTaskWait,
  presentTaskStatus,
} from "@goat/client-runtime/goatBot";
import {
  BotId,
  CHANNEL_LIST_TASKS_MAX_LIMIT,
  MAIN_BOT_ID,
  type EnvironmentId,
} from "@goat/contracts";
import { type ReactNode, useEffect } from "react";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useGoatBotMember, useGoatBotName } from "./goatBotMemberContext";
import { useGoatBotTaskChanges } from "./useGoatBotTaskChanges";
import { GoatBotPanelEmpty, GoatBotPanelFailure } from "./GoatBotPanelEmpty";
import { GoatBotCardSkeleton } from "./GoatBotSectionCard";

/** The machines GOAT Bot's running work uses, from its task list, scoped to this one bot. */
export function GoatBotComputer({
  environmentId,
  botId = null,
}: {
  environmentId: EnvironmentId;
  /** The member's id; null asks for the main bot, where the server scopes by bot at all. */
  botId?: BotId | null;
}) {
  const changes = useGoatBotTaskChanges(environmentId);
  const member = useGoatBotMember();
  const botName = useGoatBotName();
  // Before bot ids the server lists the one bot's work; with them, the main bot needs its id too,
  // or the card shows every member's work beside the main bot's.
  const environment = useEnvironment(environmentId);
  const members = environment?.serverConfig?.environment.capabilities.goatBotMembers === true;
  const scope = botId ?? member?.botId ?? (members ? BotId.make(MAIN_BOT_ID) : null);
  const tasks = useEnvironmentQuery(
    channelEnvironment.listTasks({
      environmentId,
      input: {
        status: [...BOT_RUNNING_TASK_STATUSES],
        limit: CHANNEL_LIST_TASKS_MAX_LIMIT,
        ...(scope === null ? {} : { botId: scope }),
      },
    }),
  );
  const refresh = tasks.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Work starts and moves between machines on the server; read the list again each time the tab opens.
  useEffect(() => {
    if (changes) refresh();
  }, [refresh, changes]);
  if (environment?.connection.phase === "offline")
    return (
      <Inset>
        <GoatBotPanelFailure
          message={`${botName}'s machines are unavailable while the computer is offline.`}
        />
      </Inset>
    );
  if (
    tasks.failure !== null &&
    typeof tasks.failure === "object" &&
    "_tag" in tasks.failure &&
    tasks.failure._tag === "EnvironmentAuthorizationError"
  )
    return (
      <Inset>
        <GoatBotPanelFailure message={`This device can't read ${botName}'s machines.`} />
      </Inset>
    );
  if (tasks.failure !== null)
    return (
      <Inset>
        <GoatBotPanelFailure message={`Couldn't load ${botName}'s machines.`} onRetry={refresh} />
      </Inset>
    );
  if (tasks.data === null)
    return (
      <>
        <p className="sr-only">Loading machines…</p>
        <GoatBotCardSkeleton rows={2} />
      </>
    );
  const groups = botComputers(tasks.data.tasks);
  if (groups.length === 0)
    return (
      <Inset>
        <GoatBotPanelEmpty
          title="No work running"
          next={`Machines ${botName} works on will appear here.`}
        />
      </Inset>
    );
  return (
    <div className="space-y-4 px-3 py-3">
      {groups.map((group) => (
        <section key={group.host ?? ""}>
          <h3 className="font-semibold">{group.host ?? `${botName}'s computer`}</h3>
          <ul className="mt-1 space-y-1">
            {group.tasks.map((task) => (
              <li key={task.taskId}>
                {task.title}
                <span className="block text-xs text-muted-foreground">
                  {goatBotTaskWait({
                    status: task.status,
                    openQuestionCount: task.openQuestions.length,
                    observed: task.observed,
                  }) ?? presentTaskStatus(task.status, null).label}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {tasks.data.nextCursor !== undefined && (
        <p className="text-xs text-muted-foreground">
          More tasks are running than this list shows.
        </p>
      )}
    </div>
  );
}

/** Machines' text sits inside its card the way the other sections' rows do. */
function Inset({ children }: { readonly children: ReactNode }) {
  return <div className="px-3 py-3">{children}</div>;
}
