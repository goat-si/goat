import type { PreviewSession, PreviewSessionSnapshot } from "@goat/contracts";
import { ThreadId } from "@goat/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { useBrowserLayoutZoomFactor } from "~/browser/useBrowserLayoutZoomFactor";
import { cn } from "~/lib/utils";
import { type DesktopPreviewOverlay, useThreadPreviewState } from "~/previewStateStore";

import { AgentBrowserCursor } from "../AgentBrowserCursor";
import { useDesktopCardPreviewSession } from "../usePreviewSession";
import { BROWSER_SCREEN_ASPECT, FittedScreen } from "./PreviewSessionThumbnail";

/**
 * The stack is `fixed z-40`, so anything inside a card stays below 40. The tab's webview sits just
 * above the stack, and the picture's controls and cursor sit above the webview in a layer of their
 * own. Dialogs (50), toasts, menus and tooltips stay above both.
 */
const WEBVIEW_Z_INDEX = 41;
const OVERLAY_Z_INDEX = 42;
/** The screen's rounded-lg corners, so the webview is clipped like the screen it stands for. */
const SCREEN_RADIUS_PX = 8;

/** Marks the stack's scrolling list; a webview is shown only while its picture is fully inside it. */
export const AGENT_CARDS_SCROLL_ATTRIBUTE = "data-agent-cards-scroll";

/** Agent sessions list only server tabs; assumed until the thread's preview list has loaded the tab. */
const SERVER_TAB = { runtime: "server" } as const;

/** The snapshot an agent browser card checks to decide whether this desktop draws its webview. */
export function cardServerTabSnapshot(
  session: PreviewSession,
  sessions:
    | Readonly<Record<string, Pick<PreviewSessionSnapshot, "runtime" | "serverRendered">>>
    | undefined,
): Pick<PreviewSessionSnapshot, "runtime" | "serverRendered"> | null {
  if (session.target.kind !== "browser") return null;
  return sessions?.[session.target.tabId] ?? SERVER_TAB;
}

/**
 * The id this desktop hosts a browser tab's webview under, from the thread's own preview state,
 * which ElectronBrowserHost hosts from. Null until that state lists the tab as a server tab, and
 * new whenever the server restarts, so a card never holds a tab the host no longer draws.
 */
export function useHostedTab(session: PreviewSession): {
  readonly runtimeTabId: string;
  readonly overlay: DesktopPreviewOverlay | null;
} | null {
  const threadId = session.threadId;
  const tabId = session.target.kind === "browser" ? session.target.tabId : null;
  const threadRef =
    threadId === undefined || tabId === null
      ? null
      : { environmentId: session.environmentId, threadId: ThreadId.make(threadId) };
  useDesktopCardPreviewSession(threadRef);
  const state = useThreadPreviewState(threadRef);
  const snapshot = tabId === null ? undefined : state.sessions[tabId];
  if (
    threadRef === null ||
    tabId === null ||
    snapshot?.runtime !== "server" ||
    snapshot.serverRendered === true
  )
    return null;
  return {
    runtimeTabId: previewRuntimeTabId(threadRef, state.serverEpoch, tabId),
    overlay: state.desktopByTabId[tabId] ?? null,
  };
}

/** Whether the element is entirely inside the stack's scrolling list (or the window). */
function useFullyInView(element: HTMLElement | null) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (element === null) return;
    const root = element.closest(`[${AGENT_CARDS_SCROLL_ATTRIBUTE}]`);
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) setInView(entry.isIntersecting && entry.intersectionRatio >= 0.99);
      },
      { root, threshold: [0, 0.99, 1] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return inView;
}

/**
 * A browser tab this desktop draws, shown in the card the way the right panel shows it: the tab's
 * own webview placed over the picture. It never takes the tab from the panel or the floating
 * player; while one of them shows it, or the picture is scrolled partly out of the stack, the card
 * shows `fallback`. The picture's controls and the agent's cursor follow the webview's rect.
 */
export function NativeBrowserPicture(props: {
  readonly hosted: {
    readonly runtimeTabId: string;
    readonly overlay: DesktopPreviewOverlay | null;
  };
  readonly live: boolean;
  /** Changes whenever the stack moves the card without resizing it. */
  readonly layoutVersion: string;
  /** The picture's corner controls, drawn in the card or, over the webview, in the layer above it. */
  readonly controls: (layer: { readonly overWebview: boolean }) => ReactNode;
  readonly fallback: ReactNode;
}) {
  const { runtimeTabId, overlay } = props.hosted;
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const inView = useFullyInView(element);
  const [presented, setPresented] = useState(false);
  const rect = useBrowserSurfaceStore((state) =>
    presented ? (state.byTabId[runtimeTabId]?.rect ?? null) : null,
  );
  const zoomFactor = useBrowserLayoutZoomFactor(overlay?.zoomFactor ?? 1);
  const covered = presented && rect !== null;
  return (
    <>
      <div ref={setElement} className="relative size-full">
        <div className={cn("size-full", covered && "invisible")} aria-hidden={covered || undefined}>
          {props.fallback}
        </div>
        <div className="absolute inset-0">
          <FittedScreen aspect={BROWSER_SCREEN_ASPECT} lifted={covered}>
            <BrowserSurfaceSlot
              tabId={runtimeTabId}
              visible={props.live && inView && overlay?.hasWebContents !== false}
              passive
              fitSourceContent
              cornerRadius={SCREEN_RADIUS_PX}
              zIndex={WEBVIEW_Z_INDEX}
              layoutVersion={props.layoutVersion}
              onPresentedChange={setPresented}
              className="absolute inset-0"
            />
          </FittedScreen>
        </div>
        {covered ? null : props.controls({ overWebview: false })}
      </div>
      {covered
        ? createPortal(
            <div
              data-agent-card-overlay
              className="group/card pointer-events-none fixed overflow-hidden"
              // The layer sits outside the stack, so the wheel over its controls scrolls the stack.
              onWheel={(event) =>
                element
                  ?.closest(`[${AGENT_CARDS_SCROLL_ATTRIBUTE}]`)
                  ?.scrollBy({ left: event.deltaX, top: event.deltaY })
              }
              style={{
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
                zIndex: OVERLAY_Z_INDEX,
                borderRadius: SCREEN_RADIUS_PX,
              }}
            >
              <AgentBrowserCursor
                tabId={runtimeTabId}
                zoomFactor={zoomFactor}
                controller={overlay?.controller ?? "none"}
              />
              {props.controls({ overWebview: true })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
