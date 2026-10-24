import {
  PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
  PREVIEW_SESSION_THUMBNAIL_WIDTH,
} from "@goat/client-runtime/state/preview-sessions";
import type { PreviewSession } from "@goat/contracts";
import { useSyncExternalStore } from "react";

import { LockIcon, MonitorIcon } from "~/components/solar";
import { ServerBrowserSurface } from "~/browser/ServerBrowserSurface";

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
