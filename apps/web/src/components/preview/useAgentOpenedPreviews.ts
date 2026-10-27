import type { DeviceServiceState, ScopedThreadRef } from "@goat/contracts";
import { useEffect, useRef } from "react";
import {
  usePreviewMiniPlayerStore,
  type PreviewMiniPlayerState,
} from "../../previewMiniPlayerStore";
import { floatPreview } from "./floatPreview";

/**
 * Shows the devices an agent starts for the open thread. Browser tabs an agent opens are shown for
 * every thread by startAgentOpenedPreviews, so this hook leaves them alone.
 */
export function useAgentOpenedPreviews(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly deviceState: DeviceServiceState;
  readonly deviceStateLoaded: boolean;
  readonly miniPlayerSource: PreviewMiniPlayerState["source"] | null;
  // Sheet layouts show neither floating previews nor auto-opened device tabs.
  readonly sheetLayout: boolean;
}) {
  const { threadRef, deviceState, deviceStateLoaded, miniPlayerSource, sheetLayout } = input;
  // Baseline sessions to preserve dismissals on reload; missing device summaries must remain eligible to open
  // later.
  const previousDeviceSessions = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    if (!threadRef || !deviceStateLoaded) return;
    const threadKey = `${threadRef.environmentId}:${threadRef.threadId}`;
    const sessions = deviceState.sessions.filter(
      (session) => session.threadId === threadRef.threadId,
    );
    const key = (session: (typeof sessions)[number]) => `${session.hostId}:${session.deviceId}`;
    const deviceFor = (session: (typeof sessions)[number]) =>
      deviceState.devices.find(
        (entry) => entry.hostId === session.hostId && entry.id === session.deviceId,
      );
    const previous = previousDeviceSessions.current.get(threadKey);
    previousDeviceSessions.current.set(
      threadKey,
      new Set(sessions.filter((session) => deviceFor(session) !== undefined).map(key)),
    );
    if (!previous || sheetLayout) return;
    for (const session of sessions) {
      if (previous.has(key(session))) continue;
      const device = deviceFor(session);
      if (!device) continue;
      floatPreview(
        threadRef,
        {
          kind: "device",
          hostId: session.hostId,
          deviceId: session.deviceId,
          platform: device.platform,
          name: device.name,
        },
        { by: "agent" },
      );
    }
  }, [threadRef, deviceStateLoaded, sheetLayout, deviceState.sessions, deviceState.devices]);

  // A floating device follows its session: once the agent or another client
  // closes the device there is nothing left to stream.
  useEffect(() => {
    if (!threadRef || !deviceStateLoaded) return;
    const source = miniPlayerSource;
    if (source?.kind !== "device") return;
    const sessionStillExists = deviceState.sessions.some(
      (session) =>
        session.threadId === threadRef.threadId &&
        session.hostId === source.hostId &&
        session.deviceId === source.deviceId,
    );
    if (!sessionStillExists) usePreviewMiniPlayerStore.getState().close(threadRef);
  }, [miniPlayerSource, threadRef, deviceState.sessions, deviceStateLoaded]);
}
