import { noteThreadFeedReplyDrawn } from "@goat/client-runtime/state/thread-stream-diagnostics";
import { useEffect } from "react";

/**
 * Sits inside a feed row, so it commits only when the list really drew that row. Diagnostics
 * compare its text length with what the stream delivered to tell a stalled list from a stalled stream.
 */
export function ThreadFeedReplyProbe(props: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly length: number;
}) {
  const { environmentId, threadId, messageId, length } = props;
  // oxlint-disable-next-line goat/react-effect-budget -- Reports a committed row to the on-device diagnostics store, which lives outside React.
  useEffect(() => {
    noteThreadFeedReplyDrawn(environmentId, threadId, messageId, length);
  }, [environmentId, threadId, messageId, length]);
  return null;
}
