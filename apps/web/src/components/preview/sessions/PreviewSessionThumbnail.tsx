import {
  agentCursorPlacement,
  PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
  PREVIEW_SESSION_THUMBNAIL_WIDTH,
} from "@goat/client-runtime/state/preview-sessions";
import type { PreviewSession, PreviewSessionNoPicture } from "@goat/contracts";
import type { PreviewStreamControl } from "@goat/client-runtime/preview/server-browser-stream";
import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  GlobeIcon,
  LockIcon,
  MonitorIcon,
  MousePointerClickIcon,
  MousePointerIcon,
} from "~/components/solar";
import { type ServerBrowserHandle, ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
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
 * A browser tab's picture. The card is a passive, low-rate view; the large size is the tab's
 * interactive stream. The stream says a secret field has focus before the session list does, so
 * its signal hides the picture from everyone but the person typing it, and the surface wipes
 * what was painted (#1336). Hidden stays hidden across a reconnect until the stream says otherwise.
 */
function BrowserThumbnail(props: {
  readonly session: PreviewSession;
  readonly tabId: string;
  readonly threadId: string;
  readonly live: boolean;
  readonly stopped: boolean;
  readonly large: boolean;
  readonly surfaceRef?: RefObject<ServerBrowserHandle | null> | undefined;
  readonly onStreamControl?: ((control: PreviewStreamControl | null) => void) | undefined;
}) {
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
          ref={props.surfaceRef ?? null}
          environmentId={props.session.environmentId}
          threadId={props.threadId}
          tabId={props.tabId}
          // A stopped tab keeps its last frame on the canvas, dimmed.
          visible={props.live && !props.stopped}
          followSize={false}
          controlPosition="none"
          {...(props.large
            ? {}
            : {
                thumbnail: {
                  frameIntervalMs: PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
                  maxWidth: PREVIEW_SESSION_THUMBNAIL_WIDTH,
                },
              })}
          onControl={(control) => {
            props.onStreamControl?.(control);
            // A disconnect (null) keeps the last answer: only the stream can lift privacy.
            if (control !== null)
              setStreamPrivate(control.private === true && control.controller !== "you");
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

/** Why a desktop window shows no picture, said only when a person can do something about it. */
/** Why there is no picture, every reason the server or helper gives; "private" draws a lock. */
const NO_PICTURE: Record<Exclude<PreviewSessionNoPicture, "private">, string> = {
  screenRecordingNotGranted: "Allow Screen Recording for GOAT Computer Use",
  appNotApproved: "This app is not approved for the agent",
  windowGone: "The window is closed",
  windowUnknown: "Waiting for the agent's window",
  paused: "Paused",
  stopped: "Stopped",
  unsupported: "This computer cannot show a picture",
  captureFailed: "Could not capture the window",
};

/**
 * The agent's window, captured on its own (#1404). Frames stream only while the card shows; a
 * stopped session keeps its last frame, dimmed, and a private one keeps nothing.
 */
function DesktopThumbnail(props: {
  readonly session: PreviewSession;
  readonly live: boolean;
  readonly stopped: boolean;
}) {
  const { session } = props;
  const watching = props.live && !props.stopped && session.capabilities.frames;
  const { event } = useDesktopSessionFrame(session.environmentId, watching ? session.id : null);
  const [last, setLast] = useState<string | null>(null);
  const frame = event?.type === "frame" ? `data:${event.mime};base64,${event.data}` : null;
  const reason = event?.type === "unavailable" ? event.reason : undefined;
  // Kept for a stopped session; adjusted while rendering, as the last event decides it.
  const kept = frame ?? (reason === "private" ? null : last);
  if (kept !== last) setLast(kept);
  const shown = frame ?? (props.stopped ? last : null);
  const size = event?.type === "frame" ? { width: event.width, height: event.height } : null;
  if (shown !== null)
    return (
      <div className="relative size-full">
        <img
          alt=""
          className={cn("size-full object-contain", props.stopped && "opacity-50 grayscale")}
          src={shown}
        />
        {props.stopped || size === null ? null : <AgentCursor session={session} frame={size} />}
      </div>
    );
  if (reason === "private") return <Placeholder icon="lock" text="Private" />;
  return (
    <Placeholder
      icon="monitor"
      text={props.stopped ? undefined : reason === undefined ? "No preview" : NO_PICTURE[reason]}
      className={props.stopped ? "opacity-50" : undefined}
    />
  );
}

/**
 * Where the agent's cursor is on the window, drawn over its live picture like the helper draws it
 * on screen. Positioned once per frame or resize; it moves without a repeating animation.
 */
function AgentCursor(props: {
  readonly session: PreviewSession;
  readonly frame: { readonly width: number; readonly height: number };
}) {
  const box = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    return observeResize(element, () =>
      setMeasured({ width: element.clientWidth, height: element.clientHeight }),
    );
  }, []);
  const target = props.session.target;
  const cursor =
    target.kind === "desktop" && target.cursor?.windowId === target.windowId
      ? target.cursor
      : undefined;
  const place = cursor && agentCursorPlacement(cursor, props.frame, measured);
  return (
    <div ref={box} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {place === undefined ? null : (
        <span
          data-testid="agent-cursor"
          data-phase={cursor?.phase}
          className="absolute top-0 left-0 transition-transform duration-150 ease-out"
          style={{ transform: `translate(${place.left}px, ${place.top}px)` }}
        >
          {cursor?.phase === "acting" ? (
            <span className="absolute -top-2 -left-2 size-4 rounded-full border-2 border-primary/80" />
          ) : null}
          <MousePointerIcon className="size-4 text-primary drop-shadow" />
        </span>
      )}
    </div>
  );
}

/** What a card shows of its session: its picture, or a quiet placeholder. Never a private screen. */
export function PreviewSessionThumbnail(props: {
  readonly session: PreviewSession;
  readonly live: boolean;
  readonly size?: "card" | "large" | undefined;
  /**
   * This desktop draws the browser tab in a <webview> that paints only while on screen. A card
   * streaming it parked would stay empty and hold an agent's snapshot behind a still that never
   * comes, so the card names it and opening it shows the webview itself.
   */
  readonly drawnHere?: boolean | undefined;
  /** The large browser view's stream, for Take over and Hand back. */
  readonly surfaceRef?: RefObject<ServerBrowserHandle | null> | undefined;
  readonly onStreamControl?: ((control: PreviewStreamControl | null) => void) | undefined;
}) {
  const { session } = props;
  const large = props.size === "large";
  const stopped = session.status === "stopped";
  // The large browser view may be the controller itself, typing a secret: it keeps its stream,
  // which sends a private page only to its controller. A card is never the controller.
  // A person still holding a stopped tab keeps it: dropping the stream would release their control.
  const interactive =
    large && session.target.kind === "browser" && (!stopped || session.owner !== "agent");
  if (!interactive && session.owner === "private")
    return <Placeholder icon="lock" text="Private" />;
  // A person who took over is working in their own view; a card does not watch them.
  if (!interactive && session.owner === "human")
    return <Placeholder icon="person" text="A person is in control" />;
  // A turn the desktop gave no driver: say what a person must do (#1399); only a macOS grant
  // lives in System Settings, a Windows desktop block's title says where to act (#1516).
  if (session.status === "permission-needed")
    return (
      <Placeholder
        icon="lock"
        text={`No computer use yet. ${session.target.kind === "desktop" ? session.target.title : "Allow it"}${session.reason === "permissionsNotGranted" || session.reason === undefined ? " (System Settings > Privacy & Security)" : ""}.`}
      />
    );
  if (props.drawnHere && session.target.kind === "browser")
    return (
      <Placeholder
        icon="globe"
        text={stopped ? undefined : "Open to watch"}
        className={stopped ? "opacity-50" : undefined}
      />
    );
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
        stopped={stopped && !interactive}
        large={large}
        surfaceRef={props.surfaceRef}
        onStreamControl={props.onStreamControl}
      />
    );
  if (session.target.kind === "desktop")
    return <DesktopThumbnail session={session} live={props.live} stopped={stopped} />;
  return (
    <Placeholder
      icon="globe"
      text={stopped ? undefined : "No preview"}
      className={stopped ? "opacity-50" : undefined}
    />
  );
}
