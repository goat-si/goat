import type { MessageId } from "@goat/contracts";

import { AppText as Text } from "../../components/ui/AppText";
import { useQueuedMessageWaitReason } from "../../state/threadOutboxWaitReasons";

/** The server's reason a pending message is still waiting, such as a mode change refused mid-turn. */
export function PendingMessageWaitReason(props: { readonly messageId: MessageId }) {
  const reason = useQueuedMessageWaitReason(props.messageId);
  if (reason === undefined) return null;
  return (
    <Text className="mt-1 self-end pr-0.5 text-right text-xs text-foreground-secondary">
      {reason}
    </Text>
  );
}
