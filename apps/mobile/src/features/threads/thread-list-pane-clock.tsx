import { formatWorkingDurationLabel } from "@goat/client-runtime/state/models";
import { createContext, use } from "react";
import { Platform, Text as NativeText } from "react-native";

import { useVisibleSecondClock } from "./use-visible-second-clock";

/**
 * Whether the list pane is shown, for the iPad sidebar: it stays on screen while its route loses
 * focus to an open thread, and stays mounted when hidden. Undefined elsewhere, where focus decides.
 */
export const ThreadListPaneVisibleContext = createContext<boolean | undefined>(undefined);

/** Elapsed time after a Working or Waiting label. */
export function ThreadListV2Duration(props: { readonly startedAt: string | null }) {
  const startedAtMs = Date.parse(props.startedAt ?? "");
  const nowMs = useVisibleSecondClock(Number.isFinite(startedAtMs), {
    paneVisible: use(ThreadListPaneVisibleContext),
  });
  if (!Number.isFinite(startedAtMs)) return null;
  return (
    <>
      {" "}
      <NativeText
        style={{
          fontFamily: Platform.OS === "ios" ? "System" : "sans-serif",
          fontWeight: "700",
          fontVariant: ["tabular-nums"],
        }}
      >
        {formatWorkingDurationLabel(nowMs - startedAtMs)}
      </NativeText>
    </>
  );
}
