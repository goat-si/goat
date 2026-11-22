import {
  answerBotAttentionApproval,
  botAttentionDecisionInput,
  botAttentionRemoteApproval,
  isOpenBotAttentionDecision,
  botAttentionDecisionTarget,
  botAttentionRequest,
} from "@goat/client-runtime/goatBot";
import { BotId, MAIN_BOT_ID, type ChannelTaskId, type EnvironmentId } from "@goat/contracts";
import type {
  ChannelAttentionRequest,
  ChannelAttentionTarget,
} from "@goat/contracts/channel-bot-attention";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Link } from "@tanstack/react-router";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";
import { SidebarInset } from "../ui/sidebar";

interface Target {
  readonly environmentId: EnvironmentId;
  readonly taskId: ChannelTaskId;
  readonly botId?: BotId | undefined;
  readonly requestId?: string | undefined;
  readonly request?: ChannelAttentionRequest | undefined;
  readonly generation?: number | undefined;
}

function useAlertTask({ environmentId, taskId, botId, requestId }: Target) {
  const allowed = useAtomValue(channelEnvironment.listBotAttention.permissionAtom(environmentId));
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
  environmentId: taskEnvironment,
  task,
  requestId,
  request: native,
  generation,
  taskId,
  botId,
}: Target & {
  readonly task: NonNullable<ReturnType<typeof useAlertTask>["data"]>;
}) {
  if (native !== undefined) {
    const isRemoteApproval =
      (generation === undefined || task.generation === generation) &&
      botAttentionRemoteApproval(task, native);
    if (!isRemoteApproval) return null;
    return (
      <RemoteApproval
        key={JSON.stringify([taskEnvironment, taskId, generation, native])}
        request={native}
        target={{
          environmentId: taskEnvironment,
          botId: botId ?? BotId.make(MAIN_BOT_ID),
          taskId,
          request: native,
          ...(generation === undefined ? {} : { generation }),
        }}
      />
    );
  }
  const request = botAttentionRequest(task, requestId);
  if (request === null) return null;
  if (request.kind === "question") return <p className="whitespace-pre-wrap">{request.text}</p>;
  if (request.kind === "answered") {
    return <p className="whitespace-pre-wrap">{request.text ?? "Answer recorded."}</p>;
  }
  const decision = botAttentionDecisionTarget(taskEnvironment, task, requestId);
  return (
    <p>
      {request.kind === "approval" ? "Approval needed." : "The worker has a question."}{" "}
      {decision === null ? (
        "The worker’s computer is unavailable."
      ) : (
        <Link className="underline" to="/decisions" search={decision}>
          Open request
        </Link>
      )}
    </p>
  );
}

function RemoteApproval({
  target,
  request,
}: {
  readonly target: ChannelAttentionTarget;
  readonly request: ChannelAttentionRequest;
}) {
  const registry = useContext(RegistryContext);
  const allowed = useAtomValue(
    serverEnvironment.answerDecision.permissionAtom(target.environmentId),
  );
  const query = useEnvironmentQuery(
    serverEnvironment.decisionItem({
      environmentId: target.environmentId,
      input: botAttentionDecisionInput(request),
    }),
  );
  const item = query.successResult?.value;
  const destination = item?.from.environmentId;
  const pending =
    item?.pending?.approval !== undefined && isOpenBotAttentionDecision(item, request);
  const [status, setStatus] = useState<"idle" | "saving" | "answered" | "unavailable">("idle");
  const respond = async (decision: "accept" | "decline") => {
    if (!pending || destination === undefined || !allowed) return;
    setStatus("saving");
    const accepted = await answerBotAttentionApproval(
      registry,
      channelEnvironment,
      serverEnvironment,
      target,
      decision,
      destination,
    );
    setStatus(accepted ? "answered" : "unavailable");
  };
  return (
    <div className="space-y-2">
      <p>Approval needed on {request.host}.</p>
      {pending ? <p className="whitespace-pre-wrap">{item.context}</p> : null}
      {!pending && status !== "answered" ? (
        <p role="status">
          {query.isPending ? "Checking approval…" : "This approval is unavailable."}
        </p>
      ) : null}
      {status === "answered" ? (
        <p role="status">Response sent.</p>
      ) : (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!pending || destination === undefined || !allowed || status === "saving"}
            onClick={() => void respond("accept")}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!pending || destination === undefined || !allowed || status === "saving"}
            onClick={() => void respond("decline")}
          >
            Decline
          </Button>
        </div>
      )}
      {status === "unavailable" ? <p role="alert">This approval could not be answered.</p> : null}
    </div>
  );
}

export function GoatBotAlertRequest(props: Target) {
  const task = useAlertTask(props).successResult?.value;
  if (!task) return null;
  return (
    <div className="border-b px-4 py-3 text-sm">
      <AlertRequest {...props} task={task} />
    </div>
  );
}

export function GoatBotAlertTask(props: Target) {
  const result = useAlertTask(props);
  const task = result.successResult?.value;
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
