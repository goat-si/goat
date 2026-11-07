import {
  BOT_RUNNING_TASK_STATUSES,
  botComputers,
  presentTaskStatus,
} from "@goat/client-runtime/goatBot";
import { CHANNEL_LIST_TASKS_MAX_LIMIT, type EnvironmentId } from "@goat/contracts";
import { useEffect } from "react";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { useGoatBotMember } from "./goatBotMemberContext";

/** The machines GOAT Bot's running work uses, from its task list. */
export function GoatBotComputer({ environmentId }: { environmentId: EnvironmentId }) {
  const member = useGoatBotMember();
  const tasks = useEnvironmentQuery(
    channelEnvironment.listTasks({
      environmentId,
      input: {
        status: [...BOT_RUNNING_TASK_STATUSES],
        limit: CHANNEL_LIST_TASKS_MAX_LIMIT,
        ...(member === null ? {} : { botId: member.botId }),
      },
    }),
  );
  const refresh = tasks.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Work starts and moves between machines on the server; read the list again each time the tab opens.
  useEffect(() => {
    refresh();
  }, [refresh]);
  if (tasks.failure !== null)
    return (
      <div className="space-y-2">
        <p>Couldn't load GOAT Bot's machines.</p>
        <Button size="xs" variant="outline" onClick={refresh}>
          Try again
        </Button>
      </div>
    );
  if (tasks.data === null) return <p className="text-muted-foreground">Loading machines…</p>;
  const groups = botComputers(tasks.data.tasks);
  if (groups.length === 0)
    return (
      <div className="space-y-1">
        <p>No work is running right now.</p>
        <p className="text-xs text-muted-foreground">
          Machines GOAT Bot works on will appear here.
        </p>
      </div>
    );
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.host ?? ""}>
          <h3 className="font-semibold">{group.host ?? "GOAT Bot's computer"}</h3>
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
