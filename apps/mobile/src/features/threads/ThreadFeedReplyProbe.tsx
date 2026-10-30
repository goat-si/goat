import { noteThreadFeedReplyRow } from "@goat/client-runtime/state/thread-stream-diagnostics";
import { use, useEffect } from "react";

import { ThreadMediaVisibleContext } from "./ThreadMarkdownVideo";

/**
 * Sits inside a feed row, so it reports only rows the list committed, with whether the row is on
 * screen. Diagnostics compare its text length with what the stream delivered.
 */
export function ThreadFeedReplyProbe(props: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly length: number;
}) {
  const { environmentId, threadId, messageId, length } = props;
  const visible = use(ThreadMediaVisibleContext);
  // oxlint-disable-next-line goat/react-effect-budget -- Reports a committed row to the on-device diagnostics store, which lives outside React.
  useEffect(() => {
    noteThreadFeedReplyRow(environmentId, threadId, messageId, { length, visible });
  }, [environmentId, threadId, messageId, length, visible]);
  // oxlint-disable-next-line goat/react-effect-budget -- Tells the diagnostics store when the row leaves the list, so a stale value is not read as drawn.
  useEffect(
    () => () => noteThreadFeedReplyRow(environmentId, threadId, messageId, null),
    [environmentId, threadId, messageId],
  );
  return null;
}
