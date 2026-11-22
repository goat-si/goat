import type { LegendListRef } from "@legendapp/list/react-native";
import { BotId, MAIN_BOT_ID, type ChannelTaskId, type EnvironmentId } from "@goat/contracts";
import type { ChannelAttentionTarget } from "@goat/contracts/channel-bot-attention";
import { lazy, type RefObject, Suspense, useEffect, useRef } from "react";

const AlertTask = lazy(async () => ({
  default: (await import("./MobileGoatBotAlertTask")).MobileGoatBotAlertTask,
}));
const AlertRequest = lazy(async () => ({
  default: (await import("./MobileGoatBotAlertTask")).MobileGoatBotAlertRequest,
}));

export function MobileGoatBotAlertTask({ target }: { readonly target: ChannelAttentionTarget }) {
  return (
    <Suspense fallback={null}>
      <AlertTask target={target} />
    </Suspense>
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
    <Suspense fallback={null}>
      <AlertRequest
        target={{ environmentId, botId: botId ?? BotId.make(MAIN_BOT_ID), taskId, requestId }}
      />
    </Suspense>
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
