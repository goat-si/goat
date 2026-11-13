import { useAtomValue } from "@effect/atom-react";
import {
  groupBotWork,
  resolveRemoteBotWork,
  type HomeCurrentOpenableLink,
} from "@goat/client-runtime/goatBot";
import type {
  BotRemoteWork,
  BotThreadRow,
  BotWorkResult,
  ChannelTaskId,
  EnvironmentId,
} from "@goat/contracts";
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
  currentLinks = null,
}: {
  environmentId: EnvironmentId;
  taskId: ChannelTaskId;
  rows: readonly BotThreadRow[];
  remoteWork: readonly BotRemoteWork[];
  currentLinks?: ReadonlyArray<HomeCurrentOpenableLink> | null;
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
  const childThreads = (query.data?.groups ?? [])
    .filter((group) => group.taskId === taskId)
    .flatMap((group) => group.children)
    .flatMap((child) =>
      child.surface === "thread_launch" && child.destination?.threadId !== undefined
        ? [{ environmentId, threadId: child.destination.threadId }]
        : [],
    );
  const rowWork = groupBotWork(rows, [], environmentId, remoteWork);
  const rowThreads =
    [...rowWork.inProgress, ...rowWork.done].find((entry) => entry.row.task.taskId === taskId)
      ?.threads ?? [];
  const seen = new Set(
    [...(currentLinks ?? []), ...rowThreads].map((link) =>
      JSON.stringify([link.environmentId, link.threadId]),
    ),
  );
  const extraChildren = childThreads.filter((thread) => {
    const key = JSON.stringify([thread.environmentId, thread.threadId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const threads =
    currentLinks === null
      ? task.threads
      : [...currentLinks.filter((link) => link.kind !== "remote"), ...extraChildren];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {task.subagents.map((agent) => (
        <span key={agent.childWorkId} className="rounded-full border border-border px-2 py-1">
          {agent.host ?? agent.destinationHint ?? "Subagent"} · {agent.label}
        </span>
      ))}
      {threads.map((thread) => (
        <Link
          key={`${thread.environmentId}:${thread.threadId}`}
          to="/$environmentId/$threadId"
          params={thread}
          className="underline"
        >
          Open work thread
        </Link>
      ))}
      {currentLinks === null ? (
        task.remote.map((item) => <GoatBotRemoteWork key={item.childWorkId} item={item} />)
      ) : (
        <>
          {currentLinks
            .filter((link) => link.kind === "remote")
            .map((link) => {
              const item = task.remote.find(
                (remote) => remote.childWorkId === link.remoteChildWorkId,
              );
              return (
                <Link
                  key={link.remoteChildWorkId}
                  to="/$environmentId/$threadId"
                  params={link}
                  className="underline"
                >
                  Open work thread on {item?.host ?? "remote"}
                </Link>
              );
            })}
          {task.remote
            .filter(
              (item) =>
                !currentLinks.some(
                  (link) => link.kind === "remote" && link.remoteChildWorkId === item.childWorkId,
                ),
            )
            .map((item) => {
              const target = resolveRemoteBotWork(item, () => false);
              return target.kind === "unavailable" ? (
                <span
                  key={item.childWorkId}
                  className="rounded-full border border-border px-2 py-1"
                >
                  {target.host} · {target.label}
                </span>
              ) : null;
            })}
        </>
      )}
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

/** Work from a lookup whose task view could not be read. */
export function GoatBotUnavailableWork({ work }: { work: BotWorkResult }) {
  return (
    <details className="px-3 text-xs text-muted-foreground">
      <summary>Show work</summary>
      <div className="flex flex-wrap items-center gap-2">
        {work.codingRows.map((row) => (
          <Link
            key={`${row.environmentId}:${row.threadId}`}
            to="/$environmentId/$threadId"
            params={row}
            className="underline"
          >
            {row.title ?? "Open work thread"}
          </Link>
        ))}
        {work.remoteWork.map((item) => (
          <GoatBotRemoteWork key={item.childWorkId} item={item} />
        ))}
      </div>
    </details>
  );
}
