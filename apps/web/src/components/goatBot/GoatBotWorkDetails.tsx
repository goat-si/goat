import { groupBotWork } from "@goat/client-runtime/goatBot";
import type { BotThreadRow, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";

export function GoatBotWorkDetails({
  environmentId,
  taskId,
  rows,
}: {
  environmentId: EnvironmentId;
  taskId: ChannelTaskId;
  rows: readonly BotThreadRow[];
}) {
  const environment = useEnvironment(environmentId);
  const supported =
    environment?.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities?.goatBotChildWork === true;
  const query = useEnvironmentQuery(
    supported
      ? channelEnvironment.listChildWork({ environmentId, input: { taskIds: [taskId] } })
      : null,
  );
  const work = groupBotWork(rows, query.data?.groups ?? [], environmentId);
  const task = [...work.inProgress, ...work.done].find((entry) => entry.row.task.taskId === taskId);
  if (!task) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {task.subagents.map((agent) => (
        <span key={agent.childWorkId} className="rounded-full border border-border px-2 py-1">
          {agent.host ?? agent.destinationHint ?? "Subagent"} · {agent.label}
        </span>
      ))}
      {task.threads.map((thread) => (
        <Link
          key={`${thread.environmentId}:${thread.threadId}`}
          to="/$environmentId/$threadId"
          params={thread}
          className="underline"
        >
          Open work thread
        </Link>
      ))}
      {task.truncated && <span>More work is available.</span>}
      {query.error && <span>Couldn't load subagents.</span>}
    </div>
  );
}
