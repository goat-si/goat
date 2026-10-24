import {
  PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
  PREVIEW_SESSION_THUMBNAIL_WIDTH,
} from "@goat/client-runtime/state/preview-sessions";
import {
  createPreviewFramePainter,
  createPreviewStreamClient,
} from "@goat/client-runtime/preview/server-browser-stream";
import type { PreviewSession } from "@goat/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { LockIcon, MonitorIcon } from "~/components/solar";
import { refreshPreviewStreamAccess, usePreviewStreamAccess } from "~/state/previewStream";

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const documentVisible = () => document.visibilityState === "visible";

/** Whether the window shows at all; a backgrounded or minimized app streams nothing. */
export function useDocumentVisible() {
  return useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
}

function Placeholder(props: { readonly icon: "lock" | "monitor"; readonly text: string }) {
  const Icon = props.icon === "lock" ? LockIcon : MonitorIcon;
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center text-muted-foreground text-xs">
      <Icon className="size-4" />
      <span>{props.text}</span>
    </div>
  );
}

/** A browser tab's frames at a low rate, scaled down on the server, only while `live`. */
function BrowserThumbnail(props: {
  readonly session: PreviewSession;
  readonly tabId: string;
  readonly live: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const access = usePreviewStreamAccess(props.session.environmentId);
  const threadId = props.session.threadId;
  useEffect(() => {
    if (!props.live || access === null || threadId === undefined || canvas.current === null) return;
    const painter = createPreviewFramePainter(canvas.current);
    const client = createPreviewStreamClient(
      {
        access,
        threadId,
        tabId: props.tabId,
        maxWidth: PREVIEW_SESSION_THUMBNAIL_WIDTH,
        maxHeight: Math.round(PREVIEW_SESSION_THUMBNAIL_WIDTH * 0.625),
        interactive: false,
        ackDelayMs: PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
      },
      {
        onFrame: painter.paint,
        onViewport: () => undefined,
        onConnectedChange: () => undefined,
        onUnauthorized: () => refreshPreviewStreamAccess(props.session.environmentId),
      },
    );
    return () => {
      client.stop();
      painter.stop();
    };
  }, [access, props.live, props.session.environmentId, props.tabId, threadId]);
  return <canvas ref={canvas} className="size-full object-contain" aria-hidden />;
}

/** What a tile shows of its session: live pixels, or why there are none. Never a private screen. */
export function PreviewSessionThumbnail(props: {
  readonly session: PreviewSession;
  readonly live: boolean;
}) {
  const { session } = props;
  if (session.owner === "private")
    return <Placeholder icon="lock" text="Private (paused) while a person enters a secret" />;
  if (session.target.kind === "browser" && session.capabilities.frames)
    return <BrowserThumbnail session={session} tabId={session.target.tabId} live={props.live} />;
  return (
    <Placeholder
      icon="monitor"
      text={
        session.status === "stopped"
          ? "Stopped"
          : "No live picture: this computer's helper does not send window frames yet"
      }
    />
  );
}
