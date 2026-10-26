import { parseScopedThreadKey } from "@goat/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  type DesktopPreviewOpenLinkEvent,
  type DesktopPreviewPointerEvent,
  FILL_PREVIEW_VIEWPORT,
} from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { type ComponentProps, useEffect, useEffectEvent, useRef, useState } from "react";

import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { isElectron } from "~/env";
import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { useDesktopHostedPreviewSessions } from "~/components/preview/usePreviewSession";
import { useActivePreviewSessions } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserDefaults } from "./browserDefaults";
import { useBrowserPointerStore } from "./browserPointerStore";
import { acquireBrowserSurfaceActivity, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { openUrlInPreview } from "./openFileInPreview";
import { rendersServerTabNatively } from "./previewRuntime";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

export function ElectronBrowserHost() {
  const previewByThreadKey = useActivePreviewSessions();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  useDesktopHostedPreviewSessions(primaryEnvironmentId);
  const activeSessions = Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef
      ? Object.values(previewState.sessions)
          .filter(
            (snapshot) =>
              snapshot.runtime !== "server" ||
              rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, snapshot),
          )
          .map((snapshot) => ({
            threadRef,
            snapshot,
            runtimeTabId: previewRuntimeTabId(threadRef, previewState.serverEpoch, snapshot.tabId),
            pictureInPicture:
              previewState.desktopByTabId[snapshot.tabId]?.pictureInPicture ?? false,
            zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
          }))
      : [];
  });
  // Electron destroys a moved webview's guest, so the render order must not follow the server's
  // updatedAt order. Any fixed order works; this one is not a display order.
  const sessions = activeSessions.toSorted((left, right) =>
    left.runtimeTabId < right.runtimeTabId ? -1 : left.runtimeTabId > right.runtimeTabId ? 1 : 0,
  );

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;

    let lastSerializedTheme = "";
    const syncTheme = () => {
      const theme = readPreviewAnnotationTheme();
      const serializedTheme = JSON.stringify(theme);
      if (serializedTheme === lastSerializedTheme) return;
      lastSerializedTheme = serializedTheme;
      void preview.setAnnotationTheme(theme).catch(() => {
        lastSerializedTheme = "";
      });
    };
    const frameId = window.requestAnimationFrame(syncTheme);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const headObserver = new MutationObserver(syncTheme);
    headObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      headObserver.disconnect();
    };
  }, []);

  const reportedStackTabs = useRef(new Set<string>());
  const avoidStackPointer = useEffectEvent((event: DesktopPreviewPointerEvent) => {
    const bridge = window.desktopBridge?.previewSessionStack;
    if (!bridge) return;
    const session = sessions.find((candidate) => candidate.runtimeTabId === event.tabId);
    const presentation = useBrowserSurfaceStore.getState().byTabId[event.tabId];
    const webview = document.querySelector<HTMLElement>(
      `webview[data-preview-tab="${CSS.escape(event.tabId)}"]`,
    );
    let point: { x: number; y: number } | null = null;
    // Desktop helpers publish no action coordinates, and remote/server-only browsers have no
    // local screen position. Map only a visible hosted guest, never the thumbnail or hidden guest.
    if (
      session &&
      presentation?.visible &&
      webview &&
      webview.getAttribute("aria-hidden") !== "true"
    ) {
      const rect = webview.getBoundingClientRect();
      const cssWidth = Number(webview.dataset.previewCssWidth);
      const cssHeight = Number(webview.dataset.previewCssHeight);
      // The guest's CSS viewport and measured rectangle include device fitting and app/guest zoom.
      if (
        cssWidth > 0 &&
        cssHeight > 0 &&
        event.x >= 0 &&
        event.x < cssWidth &&
        event.y >= 0 &&
        event.y < cssHeight
      ) {
        point = {
          x: rect.left + (event.x * rect.width) / cssWidth,
          y: rect.top + (event.y * rect.height) / cssHeight,
        };
      }
    }
    if (point) reportedStackTabs.current.add(event.tabId);
    else reportedStackTabs.current.delete(event.tabId);
    void bridge.request({ type: "pointer", tabId: event.tabId, point }).catch((error: unknown) => {
      console.error("Could not avoid agent pointer with the floating stack", error);
    });
  });

  const hostedTabIds = sessions.map((session) => session.runtimeTabId).join("\n");
  useEffect(() => {
    const active = new Set(hostedTabIds.split("\n"));
    for (const tabId of reportedStackTabs.current) {
      if (active.has(tabId)) continue;
      reportedStackTabs.current.delete(tabId);
      void window.desktopBridge?.previewSessionStack
        ?.request({ type: "pointer", tabId, point: null })
        .catch((error: unknown) => console.error("Could not release stack pointer", error));
    }
  }, [hostedTabIds]);

  // An agent's server tab may be shown nowhere (the cards hidden, the panel closed), and a guest
  // parked outside the window composites no frames: the agent's clicks would wait for a frame and
  // time out. Keep every tab an agent drives painting, behind the app, while it is not on screen.
  const agentTabIds = sessions
    .filter(
      ({ snapshot }) => snapshot.runtime === "server" && snapshot.automationOwner !== undefined,
    )
    .map((session) => session.runtimeTabId)
    .join("\n");
  useEffect(() => {
    if (agentTabIds === "") return;
    const releases = agentTabIds.split("\n").map(acquireBrowserSurfaceActivity);
    return () => {
      for (const release of releases) release();
    };
  }, [agentTabIds]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
      avoidStackPointer(event);
    });
  }, []);

  // An agent's screenshot of a server tab waits for a frame that a guest parked outside the window
  // never composites. Keep the guest painting, behind the app, while any capture is in flight.
  const runtimeTabIdOf = useEffectEvent((threadId: string, tabId: string) => {
    const session = sessions.find(
      ({ threadRef, snapshot }) =>
        snapshot.runtime === "server" &&
        threadRef.threadId === threadId &&
        snapshot.tabId === tabId,
    );
    return session?.runtimeTabId;
  });
  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    const holds = new Map<string, { count: number; release: () => void }>();
    const unsubscribe = preview.onServerTabCapture(({ threadId, tabId, capturing }) => {
      const key = `${threadId}\u0000${tabId}`;
      const hold = holds.get(key);
      if (!capturing) {
        if (hold && --hold.count === 0) {
          holds.delete(key);
          hold.release();
        }
        return;
      }
      if (hold) {
        hold.count += 1;
        return;
      }
      const runtimeTabId = runtimeTabIdOf(threadId, tabId);
      if (runtimeTabId === undefined) return;
      holds.set(key, { count: 1, release: acquireBrowserSurfaceActivity(runtimeTabId) });
    });
    return () => {
      unsubscribe();
      for (const hold of holds.values()) hold.release();
    };
  }, []);

  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  const onOpenLink = useEffectEvent(({ tabId, url, background }: DesktopPreviewOpenLinkEvent) => {
    const source = sessions.find((session) => session.runtimeTabId === tabId);
    if (!source) return;
    void openUrlInPreview({
      threadRef: source.threadRef,
      url,
      openPreview,
      profileId: source.snapshot.profileId,
      background,
    });
  });
  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onOpenLink(onOpenLink);
  }, []);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map(({ threadRef, snapshot, runtimeTabId, pictureInPicture, zoomFactor }) => {
        const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
        return (
          <AuthorizedBrowserWebview
            key={runtimeTabId}
            threadRef={threadRef}
            tabId={snapshot.tabId}
            runtimeTabId={runtimeTabId}
            initialUrl={url}
            viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
            pictureInPicture={pictureInPicture}
            profileId={snapshot.profileId}
            zoomFactor={zoomFactor}
            serverDriven={snapshot.runtime === "server"}
            {...(snapshot.runtime === "server"
              ? {
                  serverRendering: {
                    colorScheme: snapshot.colorScheme ?? "system",
                    zoomFactor: snapshot.zoomFactor ?? 1,
                  },
                }
              : {})}
          />
        );
      })}
    </div>
  );
}

function AuthorizedBrowserWebview(props: ComponentProps<typeof HostedBrowserWebview>) {
  const canOperatePreview = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthPreviewOperateScope,
  );
  const profileId = useTabProfileId(props.profileId);
  return canOperatePreview ? <HostedBrowserWebview {...props} profileId={profileId} /> : null;
}

/**
 * It is latched once settings load: Electron fixes the partition when the guest attaches, so a
 * later settings change must not move a live tab.
 */
function useTabProfileId(profileId: string | undefined): string | undefined {
  const hydrated = useClientSettingsHydrated();
  const defaultProfileId = useBrowserDefaults().profileId;
  const [fallback, setFallback] = useState<string | undefined>(undefined);
  if (profileId === undefined && hydrated && fallback === undefined) {
    setFallback(defaultProfileId);
  }
  return profileId ?? fallback;
}
