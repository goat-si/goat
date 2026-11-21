import { botAttentionRequest } from "@goat/client-runtime/goatBot";
import { BotId, MAIN_BOT_ID, type ChannelTaskId, type EnvironmentId } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";
import { SidebarInset } from "../ui/sidebar";

interface Target {
  readonly environmentId: EnvironmentId;
  readonly taskId: ChannelTaskId;
  readonly botId?: BotId | undefined;
  readonly requestId?: string | undefined;
}

function useAlertTask({ environmentId, taskId, botId, requestId }: Target) {
  const allowed = useAtomValue(channelEnvironment.readAttentionTask.permissionAtom(environmentId));
  return useEnvironmentQuery(
    allowed
      ? channelEnvironment.getTask({
          environmentId,
          input: {
            taskId,
            botId: botId ?? BotId.make(MAIN_BOT_ID),
            ...(requestId === undefined ? {} : { attentionRequest: requestId }),
          },
        })
      : null,
  );
}

function AlertRequest({
  task,
  requestId,
}: Target & {
  readonly task: NonNullable<ReturnType<typeof useAlertTask>["data"]>;
}) {
  const request = botAttentionRequest(task, requestId);
  if (request === null) return null;
  if (request.kind === "question") return <p className="whitespace-pre-wrap">{request.text}</p>;
  if (request.kind === "answered") {
    return <p className="whitespace-pre-wrap">{request.text ?? "Answer recorded."}</p>;
  }
  const { request: ref } = request;
  return (
    <p>
      {request.kind === "approval" ? "Approval needed." : "The worker has a question."}{" "}
      {ref.host === undefined && task.worker ? (
        <Link
          className="underline"
          to="/$environmentId/$threadId"
          params={{
            environmentId: task.worker.environmentId,
            threadId: ref.threadId,
          }}
        >
          Open worker
        </Link>
      ) : null}
    </p>
  );
}

export function GoatBotAlertRequest(props: Target) {
  const task = useAlertTask(props).data;
  if (!task) return null;
  return (
    <div className="border-b px-4 py-3 text-sm">
      <AlertRequest {...props} task={task} />
    </div>
  );
}

export function GoatBotAlertTask(props: Target) {
  const result = useAlertTask(props);
  const task = result.data;
  return (
    <SidebarInset className="overflow-auto scrollbar-gutter-both">
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 py-8">
        <Link to="/bot" className="text-sm underline">
          GOAT Bot
        </Link>
        {task ? (
          <>
            <h1 className="text-xl font-semibold">{task.title}</h1>
            <AlertRequest {...props} task={task} />
            {task.resultSummary ? (
              <p className="whitespace-pre-wrap">{task.resultSummary}</p>
            ) : null}
            {task.worker?.host === undefined && task.worker ? (
              <Link
                className="underline"
                to="/$environmentId/$threadId"
                params={{
                  environmentId: task.worker.environmentId,
                  threadId: task.worker.threadId,
                }}
              >
                Open task thread
              </Link>
            ) : null}
          </>
        ) : (
          <p>{result.isPending ? "Loading task…" : "This task isn't available."}</p>
        )}
      </section>
    </SidebarInset>
  );
}
