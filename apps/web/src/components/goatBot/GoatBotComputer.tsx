import {
  BOT_RUNNING_TASK_STATUSES,
  botComputers,
  presentTaskStatus,
} from "@goat/client-runtime/goatBot";
import {
  BotId,
  CHANNEL_LIST_TASKS_MAX_LIMIT,
  MAIN_BOT_ID,
  type EnvironmentId,
} from "@goat/contracts";
import { useEffect } from "react";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { useGoatBotMember, useGoatBotName } from "./goatBotMemberContext";
import { useGoatBotTaskChanges } from "./useGoatBotTaskChanges";
import { GoatBotPanelEmpty } from "./GoatBotPanelEmpty";

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
    return <p>{botName}'s machines are unavailable while the computer is offline.</p>;
  if (
    tasks.failure !== null &&
    typeof tasks.failure === "object" &&
    "_tag" in tasks.failure &&
    tasks.failure._tag === "EnvironmentAuthorizationError"
  )
    return <p>This device can't read {botName}'s machines.</p>;
  if (tasks.failure !== null)
    return (
      <div className="space-y-2">
        <p>Couldn't load {botName}'s machines.</p>
        <Button size="xs" variant="outline" onClick={refresh}>
          Try again
        </Button>
      </div>
    );
  if (tasks.data === null) return <p className="text-muted-foreground">Loading machines…</p>;
  const groups = botComputers(tasks.data.tasks);
  if (groups.length === 0)
    return (
      <GoatBotPanelEmpty
        title="No work running"
        next={`Machines ${botName} works on will appear here.`}
      />
    );
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.host ?? ""}>
          <h3 className="font-semibold">{group.host ?? `${botName}'s computer`}</h3>
          <ul className="mt-1 space-y-1">
            {group.tasks.map((task) => (
              <li key={task.taskId}>
                {task.title}
                <span className="block text-xs text-muted-foreground">
                  {presentTaskStatus(task.status, null).label}
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
