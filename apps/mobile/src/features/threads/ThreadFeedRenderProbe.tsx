import { noteThreadFeedRendered } from "@goat/client-runtime/state/thread-stream-diagnostics";
import { useEffect } from "react";

/** Records how many rows the feed drew, so diagnostics can tell a stalled list from a stalled stream. */
export function ThreadFeedRenderProbe(props: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly rows: number;
}) {
  const { environmentId, threadId, rows } = props;
  // oxlint-disable-next-line goat/react-effect-budget -- Reports committed rows to the on-device diagnostics store, which lives outside React.
  useEffect(() => {
    noteThreadFeedRendered(environmentId, threadId, rows);
  }, [environmentId, threadId, rows]);
  return null;
}
