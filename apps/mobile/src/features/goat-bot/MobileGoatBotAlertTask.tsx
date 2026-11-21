import type { LegendListRef } from "@legendapp/list/react-native";
import { type RefObject, useEffect, useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import { botAttentionRequest } from "@goat/client-runtime/goatBot";
import {
  BotId,
  MAIN_BOT_ID,
  type ChannelTask,
  type ChannelTaskId,
  type EnvironmentId,
} from "@goat/contracts";
import { type ChannelAttentionTarget } from "@goat/contracts/channel-bot-attention";
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

function MountedAlertRequest({ target }: { readonly target: ChannelAttentionTarget }) {
  const task = useAlertTask(target).data;
  return task === null ? null : (
    <View className="px-4 py-3">
      <Request task={task} target={target} />
    </View>
  );
}

export function MobileGoatBotAlertRequest({
  requestId,
  environmentId,
  botId,
  taskId,
}: {
  readonly requestId?: string | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly botId?: BotId | undefined;
  readonly taskId?: ChannelTaskId | undefined;
}) {
  if (requestId === undefined || environmentId === null || taskId === undefined) return null;
  return (
    <MountedAlertRequest
      target={{ environmentId, botId: botId ?? BotId.make(MAIN_BOT_ID), taskId, requestId }}
    />
  );
}

export function useMobileAttentionScroll(
  list: RefObject<LegendListRef | null>,
  rows: ReadonlyArray<{ readonly kind: string; readonly answerQuestionId?: string | undefined }>,
  requestId: string | undefined,
) {
  const index =
    requestId === undefined
      ? -1
      : rows.findIndex((row) => row.kind === "bot" && row.answerQuestionId === requestId);
  const focused = useRef<string | undefined>(undefined);
  // oxlint-disable-next-line goat/react-effect-budget -- Align the native list when the alert's request first loads.
  useEffect(() => {
    if (index < 0 || focused.current === requestId) return;
    focused.current = requestId;
    void list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.3 });
  }, [index, list, requestId]);
  return index;
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
