import { useAtomValue } from "@effect/atom-react";
import { groupBotWork, resolveRemoteBotWork } from "@goat/client-runtime/goatBot";
import type { BotRemoteWork, BotThreadRow, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";

const NOT_OPENABLE = Atom.make(false).pipe(Atom.withLabel("goat-bot-remote-work:no-environment"));

/** A thread the bot launched on another machine: a link while this client can open it there. */
function GoatBotRemoteWork({ item }: { item: BotRemoteWork }) {
  const openable = useAtomValue(
    item.environmentId === undefined
      ? NOT_OPENABLE
      : channelEnvironment.remoteWorkOpenable(item.environmentId),
  );
  const target = resolveRemoteBotWork(
    item,
    (environmentId) => environmentId === item.environmentId && openable,
  );
  if (target.kind === "unavailable")
    return (
      <span className="rounded-full border border-border px-2 py-1">
        {target.host} · {target.label}
      </span>
    );
  return (
    <Link to="/$environmentId/$threadId" params={target.ref} className="underline">
      Open work thread on {target.host}
    </Link>
  );
}

export function GoatBotWorkDetails({
  environmentId,
  taskId,
  rows,
  remoteWork,
}: {
  environmentId: EnvironmentId;
  taskId: ChannelTaskId;
  rows: readonly BotThreadRow[];
  remoteWork: readonly BotRemoteWork[];
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
  const work = groupBotWork(rows, query.data?.groups ?? [], environmentId, remoteWork);
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
      {task.remote.map((item) => (
        <GoatBotRemoteWork key={item.childWorkId} item={item} />
      ))}
      {task.truncated && <span>More work is available.</span>}
      {query.error && (
        <>
          <span>Couldn't load subagents.</span>
          <Button variant="outline" size="xs" onClick={query.refresh}>
            Try again
          </Button>
        </>
      )}
    </div>
  );
}
