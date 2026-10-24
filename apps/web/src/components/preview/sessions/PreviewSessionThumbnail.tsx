import {
  PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
  PREVIEW_SESSION_THUMBNAIL_WIDTH,
} from "@goat/client-runtime/state/preview-sessions";
import type { PreviewSession, PreviewSessionNoPicture } from "@goat/contracts";
import { useSyncExternalStore } from "react";

import { LockIcon, MonitorIcon } from "~/components/solar";
import { ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import { useDesktopSessionFrame } from "~/state/previewSessions";

/** Whether the window shows at all; a backgrounded or minimized app streams nothing. */
export function useDocumentVisible(doc: Document = document) {
  return useSyncExternalStore(
    (onChange) => {
      doc.addEventListener("visibilitychange", onChange);
      return () => doc.removeEventListener("visibilitychange", onChange);
    },
    () => doc.visibilityState === "visible",
    () => true,
  );
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

const NO_PICTURE: Readonly<Record<PreviewSessionNoPicture, string>> = {
  screenRecordingNotGranted: "No live picture: allow Screen Recording for GOAT Computer Use",
  windowUnknown: "No live picture until the agent works in a window",
  windowGone: "The agent's window is closed",
  appNotApproved: "No live picture: this app is not approved for the agent",
  private: "Private (paused) while a person enters a secret",
  paused: "Paused",
  stopped: "Stopped",
  unsupported: "No live picture: this computer's helper does not send window frames",
  captureFailed: "The live picture could not be captured",
};

/** The agent's window, captured on its own: never the rest of the screen or GOAT's windows. */
function DesktopFrame(props: { readonly session: PreviewSession; readonly live: boolean }) {
  const { event, failed } = useDesktopSessionFrame(
    props.session.environmentId,
    props.live ? props.session.id : null,
  );
  if (event?.type === "frame")
    return (
      <img
        alt={`Live picture of ${props.session.target.kind === "desktop" ? props.session.target.title : "the session"}`}
        className="size-full object-contain"
        src={`data:${event.mime};base64,${event.data}`}
      />
    );
  const reason = event?.type === "unavailable" ? event.reason : undefined;
  return (
    <Placeholder
      icon={reason === "private" ? "lock" : "monitor"}
      text={
        failed
          ? "The live picture is not available on this connection"
          : reason === undefined
            ? props.live
              ? "Connecting to the live picture"
              : "Live picture paused while hidden"
            : NO_PICTURE[reason]
      }
    />
  );
}

/** What a tile shows of its session: live pixels, or why there are none. Never a private screen. */
export function PreviewSessionThumbnail(props: {
  readonly session: PreviewSession;
  readonly live: boolean;
}) {
  const { session } = props;
  if (session.owner === "private")
    return <Placeholder icon="lock" text="Private (paused) while a person enters a secret" />;
  // A person who took over is working in their own view; other clients do not watch them.
  if (session.owner === "human")
    return <Placeholder icon="lock" text="A person is controlling this tab" />;
  if (session.target.kind === "browser" && session.capabilities.frames)
    return (
      // The built-in browser's own surface, so a tile and the full preview are one view.
      <ServerBrowserSurface
        environmentId={session.environmentId}
        threadId={session.threadId ?? ""}
        tabId={session.target.tabId}
        visible={props.live && session.threadId !== undefined}
        followSize={false}
        controlPosition="none"
        thumbnail={{
          frameIntervalMs: PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
          maxWidth: PREVIEW_SESSION_THUMBNAIL_WIDTH,
        }}
        className="size-full"
      />
    );
  if (
    session.target.kind === "desktop" &&
    session.capabilities.frames &&
    session.status !== "stopped"
  )
    return <DesktopFrame session={session} live={props.live} />;
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
