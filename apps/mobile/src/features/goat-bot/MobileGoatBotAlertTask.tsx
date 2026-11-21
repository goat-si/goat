import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  answerBotAttentionApproval,
  botAttentionDecisionInput,
  botAttentionRemoteApproval,
  isOpenBotAttentionDecision,
  botAttentionDecisionTarget,
  botAttentionRequest,
} from "@goat/client-runtime/goatBot";
import type { ChannelTask } from "@goat/contracts";
import type {
  ChannelAttentionRequest,
  ChannelAttentionTarget,
} from "@goat/contracts/channel-bot-attention";
import { useLinkTo } from "@react-navigation/native";
import { View } from "react-native";
import { useContext, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";

function useAlertTask(target: ChannelAttentionTarget) {
  const allowed = useAtomValue(
    channelEnvironment.listBotAttention.permissionAtom(target.environmentId),
  );
  return useEnvironmentQuery(
    allowed
      ? channelEnvironment.getTask({
          environmentId: target.environmentId,
          input: {
            taskId: target.taskId,
            botId: target.botId,
            ...(target.requestId === undefined ? {} : { attentionRequest: target.requestId }),
          },
        })
      : null,
  );
}

function Request({
  task,
  target,
}: {
  readonly task: ChannelTask;
  readonly target: ChannelAttentionTarget;
}) {
  const linkTo = useLinkTo();
  const native = target.request;
  if (native !== undefined) {
    const isRemoteApproval =
      (target.generation === undefined || task.generation === target.generation) &&
      botAttentionRemoteApproval(task, native);
    return isRemoteApproval ? (
      <RemoteApproval
        key={JSON.stringify([target.environmentId, target.taskId, target.generation, native])}
        target={target}
        request={native}
      />
    ) : null;
  }
  const request = botAttentionRequest(task, target.requestId);
  if (request === null) return null;
  if (request.kind === "question" || request.kind === "answered")
    return <Text>{request.text ?? "Answer recorded."}</Text>;
  const decision = botAttentionDecisionTarget(target.environmentId, task, target.requestId);
  return (
    <View className="gap-2">
      <Text>{request.kind === "approval" ? "Approval needed." : "The worker has a question."}</Text>
      {decision !== null ? (
        <Text
          accessibilityRole="link"
          className="underline"
          onPress={() => linkTo("/decisions?" + new URLSearchParams(decision).toString())}
        >
          Open request
        </Text>
      ) : (
        <Text>The worker’s computer is unavailable.</Text>
      )}
    </View>
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
    <View className="gap-2">
      <Text>Approval needed on {request.host}.</Text>
      {pending ? <Text>{item.context}</Text> : null}
      {!pending && status !== "answered" ? (
        <Text>{query.isPending ? "Checking approval…" : "This approval is unavailable."}</Text>
      ) : null}
      {status === "answered" ? (
        <Text accessibilityRole="alert">Response sent.</Text>
      ) : (
        <View className="flex-row gap-2">
          <Button
            label="Approve"
            disabled={!pending || destination === undefined || !allowed || status === "saving"}
            onPress={() => void respond("accept")}
          />
          <Button
            label="Decline"
            tone="secondary"
            disabled={!pending || destination === undefined || !allowed || status === "saving"}
            onPress={() => void respond("decline")}
          />
        </View>
      )}
      {status === "unavailable" ? (
        <Text accessibilityRole="alert">This approval could not be answered.</Text>
      ) : null}
    </View>
  );
}

export function MobileGoatBotAlertRequest({ target }: { readonly target: ChannelAttentionTarget }) {
  const task = useAlertTask(target).successResult?.value;
  return task === undefined ? null : (
    <View className="px-4 py-3">
      <Request task={task} target={target} />
    </View>
  );
}

export function MobileGoatBotAlertTask({ target }: { readonly target: ChannelAttentionTarget }) {
  const result = useAlertTask(target);
  const task = result.successResult?.value;
  return (
    <ScreenScrollView contentContainerClassName="gap-3 px-5 py-5">
      {task ? (
        <>
          <Text className="text-xl font-semibold">{task.title}</Text>
          <Request task={task} target={target} />
          {task.resultSummary ? <Text>{task.resultSummary}</Text> : null}
        </>
      ) : (
        <Text>{result.isPending ? "Loading task…" : "This task isn't available."}</Text>
      )}
    </ScreenScrollView>
  );
}
