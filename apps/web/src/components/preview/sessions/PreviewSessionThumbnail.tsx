import {
  PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
  PREVIEW_SESSION_THUMBNAIL_WIDTH,
} from "@goat/client-runtime/state/preview-sessions";
import type { PreviewSession } from "@goat/contracts";
import { useRef, useState, useSyncExternalStore } from "react";

import { GlobeIcon, LockIcon, MonitorIcon, MousePointerClickIcon } from "~/components/solar";
import { type ServerBrowserHandle, ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import { cn } from "~/lib/utils";

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

const PLACEHOLDER_ICON = {
  lock: LockIcon,
  monitor: MonitorIcon,
  globe: GlobeIcon,
  person: MousePointerClickIcon,
} as const;

function Placeholder(props: {
  readonly icon: keyof typeof PLACEHOLDER_ICON;
  readonly text?: string | undefined;
  readonly className?: string | undefined;
}) {
  const Icon = PLACEHOLDER_ICON[props.icon];
  return (
    <div
      className={cn(
        "flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center text-muted-foreground text-xs",
        props.className,
      )}
    >
      <Icon className="size-4" />
      {props.text ? <span>{props.text}</span> : null}
    </div>
  );
}

/**
 * A browser tab's live picture. The stream says a secret field has focus before the session list
 * does, so its signal alone hides the picture and wipes the pixels already painted (#1336).
 */
function BrowserThumbnail(props: {
  readonly session: PreviewSession;
  readonly tabId: string;
  readonly threadId: string;
  readonly live: boolean;
  readonly stopped: boolean;
}) {
  const surface = useRef<ServerBrowserHandle | null>(null);
  const [streamPrivate, setStreamPrivate] = useState(false);
  return (
    <>
      <Placeholder icon="globe" className="absolute inset-0" />
      <div
        className={cn(
          "relative size-full",
          streamPrivate && "invisible",
          props.stopped && "opacity-50 grayscale",
        )}
        aria-hidden={streamPrivate || undefined}
        data-private-hidden={streamPrivate || undefined}
      >
        {/* The built-in browser's own surface, so a card and the full preview are one view. */}
        <ServerBrowserSurface
          ref={surface}
          environmentId={props.session.environmentId}
          threadId={props.threadId}
          tabId={props.tabId}
          // A stopped tab keeps its last frame on the canvas, dimmed.
          visible={props.live && !props.stopped}
          followSize={false}
          controlPosition="none"
          thumbnail={{
            frameIntervalMs: PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
            maxWidth: PREVIEW_SESSION_THUMBNAIL_WIDTH,
          }}
          onControl={(control) => {
            const next = control?.private === true;
            if (next) {
              const canvas = surface.current?.canvas();
              canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
            }
            setStreamPrivate(next);
          }}
          className="size-full"
        />
      </div>
      {streamPrivate ? (
        <Placeholder icon="lock" text="Private" className="absolute inset-0 bg-muted" />
      ) : null}
    </>
  );
}

/** What a card shows of its session: its picture, or a quiet placeholder. Never a private screen. */
export function PreviewSessionThumbnail(props: {
  readonly session: PreviewSession;
  readonly live: boolean;
}) {
  const { session } = props;
  if (session.owner === "private") return <Placeholder icon="lock" text="Private" />;
  // A person who took over is working in their own view; other clients do not watch them.
  if (session.owner === "human") return <Placeholder icon="person" text="A person is in control" />;
  const stopped = session.status === "stopped";
  if (
    session.target.kind === "browser" &&
    session.threadId !== undefined &&
    (session.capabilities.frames || stopped)
  )
    return (
      <BrowserThumbnail
        session={session}
        tabId={session.target.tabId}
        threadId={session.threadId}
        live={props.live}
        stopped={stopped}
      />
    );
  return (
    <Placeholder
      icon={session.kind === "browser" ? "globe" : "monitor"}
      text={stopped ? undefined : "No preview"}
      className={stopped ? "opacity-50" : undefined}
    />
  );
}
