import type { LegendListRef } from "@legendapp/list/react";
import { useRef, type RefObject } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  resolveDisclosureRevealScrollDelta,
} from "./timelineScrollAnchoring";

export function useDisclosureReveal(input: {
  listRef: RefObject<LegendListRef | null>;
  identity: string;
  composerInset: number;
  reducedMotion: boolean;
}) {
  const pendingRef = useRef<{
    key: string;
    identity: string;
    entryId?: string | undefined;
    contentKey?: string | undefined;
    ready: boolean;
  } | null>(null);
  const frameRef = useRef<number | null>(null);
  const reveal = useStableCallback(() => {
    const pending = pendingRef.current;
    if (!pending || pending.identity !== input.identity) return;
    const state = input.listRef.current?.getState();
    const element = input.listRef.current?.getScrollableNode();
    const index = state?.indexByKey(pending.key);
    const row = index === undefined ? undefined : state?.elementAtIndex(index);
    if (!element || !(row instanceof HTMLElement)) return;
    const viewport = element.getBoundingClientRect();
    const entry = pending.entryId
      ? row.querySelector<HTMLElement>(`[data-work-entry-id="${CSS.escape(pending.entryId)}"]`)
      : null;
    const contentIndex = pending.contentKey ? state?.indexByKey(pending.contentKey) : undefined;
    const content = contentIndex === undefined ? null : state?.elementAtIndex(contentIndex);
    const bounds = (entry ?? row).getBoundingClientRect();
    const delta = resolveDisclosureRevealScrollDelta({
      rowTop: bounds.top,
      rowBottom: content?.getBoundingClientRect().bottom ?? bounds.bottom,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      composerOverlayHeight: input.composerInset,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });
    if (pending.ready && element.scrollTop + delta <= element.scrollHeight - element.clientHeight)
      pendingRef.current = null;
    if (delta > 0)
      element.scrollBy({ top: delta, behavior: input.reducedMotion ? "auto" : "smooth" });
  });
  const schedule = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      reveal();
    });
  };
  return {
    reveal,
    prepare(
      key: string,
      target?: { readonly entryId?: string | undefined; readonly contentKey?: string | undefined },
    ) {
      pendingRef.current = target
        ? { key, identity: input.identity, ...target, ready: false }
        : null;
    },
    ready(key: string, entryId: string) {
      const pending = pendingRef.current;
      if (
        !pending ||
        pending.identity !== input.identity ||
        (pending.contentKey === undefined
          ? pending.key !== key || pending.entryId !== entryId
          : pending.contentKey !== key)
      )
        return;
      pending.ready = pending.contentKey === undefined;
      schedule();
    },
    clear() {
      pendingRef.current = null;
    },
    dispose() {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
  };
}
