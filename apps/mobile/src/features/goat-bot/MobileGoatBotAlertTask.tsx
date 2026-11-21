import { useAtomValue } from "@effect/atom-react";
import { botAttentionRequest } from "@goat/client-runtime/goatBot";
import type { ChannelTask } from "@goat/contracts";
import type { ChannelAttentionTarget } from "@goat/contracts/channel-bot-attention";
import { useLinkTo } from "@react-navigation/native";
import { View } from "react-native";
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
  const request = botAttentionRequest(task, target.requestId);
  if (request === null) return null;
  if (request.kind === "question" || request.kind === "answered")
    return <Text>{request.text ?? "Answer recorded."}</Text>;
  const { request: ref } = request;
  const worker = task.worker;
  return (
    <View className="gap-2">
      <Text>{request.kind === "approval" ? "Approval needed." : "The worker has a question."}</Text>
      {worker && ref.host === undefined ? (
        <Text
          accessibilityRole="link"
          className="underline"
          onPress={() =>
            linkTo(
              `/threads/${encodeURIComponent(worker.environmentId)}/${encodeURIComponent(ref.threadId)}`,
            )
          }
        >
          Open worker
        </Text>
      ) : null}
    </View>
  );
}

export function MobileGoatBotAlertRequest({ target }: { readonly target: ChannelAttentionTarget }) {
  const task = useAlertTask(target).data;
  return task === null ? null : (
    <View className="px-4 py-3">
      <Request task={task} target={target} />
    </View>
  );
}

export function MobileGoatBotAlertTask({ target }: { readonly target: ChannelAttentionTarget }) {
  const result = useAlertTask(target);
  const task = result.data;
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
