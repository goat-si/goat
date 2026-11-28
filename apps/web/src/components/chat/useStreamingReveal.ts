import { useEffect, useState } from "react";

const shownStreamingIds = new Set<string>();

/**
 * Tracks whether a streaming reply has already been displayed, so remounting it
 * (after a thread switch or virtualized scroll) does not replay the fade-in on
 * text already shown until new text arrives.
 */
export function useShouldFadeStreaming(
  text: string,
  isStreaming: boolean | undefined,
  streamingId: string | undefined,
): boolean {
  const [textAtMount] = useState(text);
  const [remounted] = useState(
    () => streamingId !== undefined && shownStreamingIds.has(streamingId),
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Records the reply outside React so the next mount after a thread switch or virtualized scroll knows it was shown.
  useEffect(() => {
    if (isStreaming && streamingId !== undefined) shownStreamingIds.add(streamingId);
  }, [isStreaming, streamingId]);
  return Boolean(isStreaming) && (!remounted || text !== textAtMount);
}
