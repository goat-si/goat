import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { LegendListRef } from "@legendapp/list/react-native";

import type { ThreadFeedLatestRun } from "../../lib/threadActivity";
import type { ThreadFeedRow } from "./pending-thread-feed";
import {
  armSettleFollowHold,
  nextSettleAnchorId,
  settleFollowHoldOffset,
  type SettleFollowHold,
} from "./turn-settle";

function replyPlace(list: LegendListRef | null, id: string) {
  const state = list?.getState();
  if (!state) return null;
  const index = state.indexByKey(id);
  if (index === undefined) return null;
  const replyTop = state.positionAtIndex(index);
  if (replyTop === undefined) return null;
  return { scroll: state.scroll, replyTop };
}

/** Mounted ahead of the list so this layout effect snapshots the reply before the fold. */
export function SettleFollowCapture(props: {
  readonly anchorId: string;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly holdRef: RefObject<SettleFollowHold | null>;
  readonly userScrolling: () => boolean;
}) {
  const { anchorId, listRef, holdRef, userScrolling } = props;
  // oxlint-disable-next-line goat/react-effect-budget -- the list applies the fold in its own layout effect, which runs after this one
  useLayoutEffect(() => {
    if (holdRef.current?.id === anchorId) return;
    holdRef.current = userScrolling()
      ? null
      : armSettleFollowHold({
          following: true,
          anchorId,
          place: replyPlace(listRef.current, anchorId),
        });
  }, [anchorId, holdRef, listRef, userScrolling]);
  return null;
}

/** The settle anchor, and a hold so a followed fold pins the end once. */
export function useThreadFeedSettleFollow(input: {
  readonly latestRun: ThreadFeedLatestRun | null;
  readonly rows: ReadonlyArray<ThreadFeedRow>;
  readonly listRef: RefObject<LegendListRef | null>;
  /** End maintenance would run for this render. */
  readonly maintainEnd: boolean;
  readonly userScrolling: () => boolean;
}) {
  const { latestRun, rows, listRef, maintainEnd, userScrolling } = input;
  const [previousLatestRun, setPreviousLatestRun] = useState(latestRun);
  const [settleAnchorId, setSettleAnchorId] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const holdRef = useRef<SettleFollowHold | null>(null);
  const frameRef = useRef<number | null>(null);
  if (previousLatestRun !== latestRun) {
    const anchor = nextSettleAnchorId(settleAnchorId, previousLatestRun, latestRun, rows);
    setPreviousLatestRun(latestRun);
    setSettleAnchorId(anchor);
    setHolding(maintainEnd && anchor !== null);
  }

  const releaseAfterLayout = useEffectEvent(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const hold = holdRef.current;
        holdRef.current = null;
        setHolding(false);
        setSettleAnchorId(null);
        if (hold && maintainEnd && !userScrolling()) {
          void listRef.current?.scrollToEnd({ animated: false });
        }
      });
    });
  });
  // oxlint-disable-next-line goat/react-effect-budget -- the fold's rows measure after commit; release the anchor once they settle
  useEffect(() => {
    if (settleAnchorId === null) return;
    releaseAfterLayout();
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [settleAnchorId]);

  return {
    anchorId: settleAnchorId,
    anchorIndex: settleAnchorId === null ? -1 : rows.findIndex((row) => row.id === settleAnchorId),
    holding,
    holdRef,
    offset: (): number | undefined => {
      const hold = holdRef.current;
      const state = listRef.current?.getState();
      if (!hold || !state) return undefined;
      const index = state.indexByKey(hold.id);
      if (index === undefined) return undefined;
      const replyTop = state.positionAtIndex(index);
      if (replyTop === undefined) return undefined;
      return settleFollowHoldOffset(hold, replyTop);
    },
    onItemSizeChanged: () => {
      if (settleAnchorId !== null) releaseAfterLayout();
    },
    dropHold: () => {
      holdRef.current = null;
      setHolding(false);
    },
  };
}
