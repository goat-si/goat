import type { MessageId } from "@goat/contracts";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";

import type { ThreadFeedHistoryControls } from "./ThreadFeed";
import {
  finishThreadMessageJump,
  pendingThreadMessageJump,
  subscribeThreadMessageJump,
} from "./threadMessageJump";

/**
 * A palette message result opens the thread at that message: earlier history loads until the
 * message is in the feed, which then scrolls to it. The jump makes its own attempt whatever error
 * is showing, and ends when its own load fails or there is no more history.
 */
export function useThreadMessageJumpLoading(input: {
  readonly threadKey: string;
  readonly feed: ReadonlyArray<{ readonly type: string; readonly id: string }>;
  readonly ready: boolean;
  readonly history: ThreadFeedHistoryControls | undefined;
}): { readonly jumpMessageId: MessageId | null; readonly jumpMessageLoaded: boolean } {
  const { threadKey, history } = input;
  const jumpMessageId: MessageId | null = useSyncExternalStore(subscribeThreadMessageJump, () =>
    pendingThreadMessageJump(threadKey),
  );
  const jumpMessageLoaded =
    jumpMessageId !== null &&
    input.feed.some((entry) => entry.type === "message" && entry.id === jumpMessageId);
  // Per thread, an attempt is in flight while more have started than settled; the screen is reused
  // across threads, and settling re-runs the effect.
  const attemptsStarted = useRef(new Map<string, number>());
  const [attemptsSettled, setAttemptsSettled] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  // History down to the message in one request; another page if it is not there yet.
  const loadEarlierForJump = useEffectEvent(() => {
    if (jumpMessageId === null || !history) return;
    attemptsStarted.current.set(threadKey, (attemptsStarted.current.get(threadKey) ?? 0) + 1);
    void history.onLoadThrough(jumpMessageId).then((loaded) => {
      if (!loaded) finishThreadMessageJump(threadKey);
      setAttemptsSettled((settled) =>
        new Map(settled).set(threadKey, (settled.get(threadKey) ?? 0) + 1),
      );
    });
  });
  const ready = input.ready;
  // oxlint-disable-next-line goat/react-effect-budget -- Loads history until the jump's message is in the feed, then ends the jump.
  useEffect(() => {
    if (jumpMessageId === null || jumpMessageLoaded || !ready) return;
    const inFlight =
      (attemptsStarted.current.get(threadKey) ?? 0) !== (attemptsSettled.get(threadKey) ?? 0);
    if (history?.loading || inFlight) return;
    if (!history?.hasMoreHistory) {
      finishThreadMessageJump(threadKey);
      return;
    }
    loadEarlierForJump();
  }, [
    ready,
    history?.hasMoreHistory,
    history?.loading,
    jumpMessageId,
    jumpMessageLoaded,
    attemptsSettled,
    threadKey,
  ]);
  return { jumpMessageId, jumpMessageLoaded };
}
