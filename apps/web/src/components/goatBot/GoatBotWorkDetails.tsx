import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
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
import { useThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { channelEnvironment } from "~/state/channels";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";

const NOT_OPENABLE = Atom.make(false).pipe(Atom.withLabel("goat-bot-remote-work:no-environment"));
const LINK = "min-w-0 max-w-full truncate underline";

/** A work thread's link text: its own title, so two threads never read the same. */
const workThreadName = (title: string | undefined) => title?.trim() || "Open work thread";

/** A thread the bot launched on another machine: a link while this client can open it there. */
function GoatBotRemoteWork({
  item,
  openable,
  onHomeNavigate,
}: {
  item: BotRemoteWork;
  openable?: boolean | undefined;
  onHomeNavigate?: ((event: React.MouseEvent) => void) | undefined;
}) {
  const connected = useAtomValue(
    openable !== undefined || item.environmentId === undefined
      ? NOT_OPENABLE
      : channelEnvironment.remoteWorkOpenable(item.environmentId),
  );
  const target = resolveRemoteBotWork(
    item,
    (environmentId) => environmentId === item.environmentId && (openable ?? connected),
  );
  const shell = useThreadShell(
    target.kind === "open" ? scopeThreadRef(target.ref.environmentId, target.ref.threadId) : null,
  );
  if (target.kind === "unavailable")
    return (
      <span className="rounded-full border border-border px-2 py-1">
        {target.host} · {target.label}
      </span>
    );
  return (
    <Link
      to="/$environmentId/$threadId"
      params={target.ref}
      onClick={onHomeNavigate}
      className={LINK}
    >
      {workThreadName(shell?.title)} on {target.host}
    </Link>
  );
}

export function GoatBotWorkDetails({
  environmentId,
  taskId,
  rows,
  remoteWork,
  currentLinks = null,
  currentRemoteIds = null,
  onHomeNavigate,
}: {
  environmentId: EnvironmentId;
  taskId: ChannelTaskId;
  rows: readonly BotThreadRow[];
  remoteWork: readonly BotRemoteWork[];
  currentLinks?: ReadonlyArray<HomeCurrentOpenableLink> | null;
  currentRemoteIds?: ReadonlyArray<string> | null;
  onHomeNavigate?: ((event: React.MouseEvent) => void) | undefined;
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
  const titles = new Map(
    rows.flatMap((row) =>
      row.kind === "coding" && row.taskId === taskId && row.title
        ? [[JSON.stringify([row.environmentId, row.threadId]), row.title] as const]
        : [],
    ),
  );
  const worker = task.row.worker;
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
          onClick={onHomeNavigate}
          className={LINK}
        >
          {worker?.environmentId === thread.environmentId && worker.threadId === thread.threadId
            ? "Open work thread"
            : workThreadName(titles.get(JSON.stringify([thread.environmentId, thread.threadId])))}
        </Link>
      ))}
      {task.remote.map((item) => (
        <GoatBotRemoteWork
          key={item.childWorkId}
          item={item}
          onHomeNavigate={onHomeNavigate}
          openable={
            currentLinks !== null && currentRemoteIds?.includes(item.childWorkId)
              ? currentLinks.some(
                  (link) => link.kind === "remote" && link.remoteChildWorkId === item.childWorkId,
                )
              : undefined
          }
        />
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
            className={LINK}
          >
            {workThreadName(row.title)}
          </Link>
        ))}
        {work.remoteWork.map((item) => (
          <GoatBotRemoteWork key={item.childWorkId} item={item} />
        ))}
      </div>
    </details>
  );
}
