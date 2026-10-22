import type { ScopedThreadRef } from "@goat/contracts";
import { type ComponentProps, useLayoutEffect } from "react";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import type { TimelineEntriesInput, TimelineEntry } from "../../session-logic";
import { useThreadVisibleTurnItems } from "../../state/entities";
import {
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
} from "../ChatView.logic";
import { MessagesTimeline } from "./MessagesTimeline";

/**
 * The timeline with the streamed text. ChatView reads the thread through its quiet
 * atoms, which hold through text deltas; this reads the live turn items, so a
 * delta re-renders the timeline without re-rendering ChatView.
 */
export function ThreadTimeline({
  threadDetailRef,
  entriesInput,
  draftEntries,
  activeThreadKey,
  syncing,
  detailLoading,
  readyMarkdownCwd,
  readyWorkspaceRoot,
  readyActivity,
  ...timelineProps
}: Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries"> & {
  /** Null until the thread's detail may load; see resolveThreadDetailRef. */
  threadDetailRef: ScopedThreadRef | null;
  entriesInput: Omit<TimelineEntriesInput, "visibleTurnItems">;
  /** A local draft's optimistic rows; null for a server thread. */
  draftEntries: ReadonlyArray<TimelineEntry> | null;
  activeThreadKey: string | null;
  syncing: boolean;
  detailLoading: boolean;
  readyMarkdownCwd: string | null;
  readyWorkspaceRoot: string | null;
  /** GOAT: the run state shown with these entries, kept so a thread switch can paint it. */
  readyActivity: Parameters<typeof rememberReadyThreadTimeline>[0]["activity"];
}) {
  const visibleTurnItems = useThreadVisibleTurnItems(threadDetailRef);
  const serverEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...entriesInput,
    visibleTurnItems,
  });
  const entries = draftEntries ?? serverEntries;
  const displayed = resolveThreadSwitchTimeline({
    loading: entries.length === 0 && syncing,
    activeThreadKey,
    nextEntries: entries,
    rememberedForActive: peekRememberedThreadTimeline<typeof entries>(activeThreadKey),
  });
  useLayoutEffect(() => {
    if (detailLoading || entries.length === 0 || timelineHasEphemeralPreviewUrls(entries)) {
      return;
    }
    rememberReadyThreadTimeline({
      threadKey: activeThreadKey,
      entries,
      markdownCwd: readyMarkdownCwd,
      workspaceRoot: readyWorkspaceRoot,
      ...(readyActivity ? { activity: readyActivity } : {}),
    });
  }, [
    activeThreadKey,
    detailLoading,
    entries,
    readyMarkdownCwd,
    readyWorkspaceRoot,
    readyActivity,
  ]);
  return <MessagesTimeline {...timelineProps} timelineEntries={displayed.entries} />;
}
