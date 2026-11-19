import type { MessageId } from "@goat/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useQueuedMessageWaitReason } from "../../state/threadOutboxWaitReasons";
import {
  retryQueuedMessage,
  UPLOAD_RETRY_EXHAUSTED_REASON,
} from "../../state/threadOutboxRetryRequests";

/** The server's reason a pending message is still waiting, such as a mode change refused mid-turn. */
export function PendingMessageWaitReason(props: { readonly messageId: MessageId }) {
  const reason = useQueuedMessageWaitReason(props.messageId);
  if (reason === undefined) return null;
  return (
    <View className="mt-1 items-end">
      <Text className="pr-0.5 text-right text-xs text-foreground-secondary">{reason}</Text>
      {reason === UPLOAD_RETRY_EXHAUSTED_REASON ? (
        <Button tone="text" label="Retry" onPress={() => retryQueuedMessage(props.messageId)} />
      ) : null}
    </View>
  );
}
