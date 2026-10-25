import {
  PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
  PREVIEW_SESSION_THUMBNAIL_WIDTH,
} from "@goat/client-runtime/state/preview-sessions";
import type { PreviewSession, PreviewSessionNoPicture } from "@goat/contracts";
import type { PreviewStreamControl } from "@goat/client-runtime/preview/server-browser-stream";
import { type RefObject, useEffect, useState, useSyncExternalStore } from "react";

import { GlobeIcon, LockIcon, MonitorIcon, MousePointerClickIcon } from "~/components/solar";
import { type ServerBrowserHandle, ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
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
const NO_PICTURE: Partial<Record<PreviewSessionNoPicture, string>> = {
  screenRecordingNotGranted: "Allow Screen Recording for GOAT Computer Use",
  appNotApproved: "This app is not approved for the agent",
  windowGone: "The window is closed",
};

/**
 * The picture each stopped desktop card shows, by session and thread: Pop out and Dock mount
 * the stack anew, in the same render that removes the old card, and a stopped session sends no
 * more frames (#1518). Only a stopped card leaves one, and a private answer or a person's
 * control removes it, so a picture from before either never comes back. Bounded, oldest first.
 */
const stoppedFrames = new Map<string, string>();
const LAST_FRAMES_KEPT = 8;

const stoppedFrameKey = (session: PreviewSession) =>
  `${session.environmentId}\u0000${session.id}\u0000${session.threadId ?? ""}`;

function keepStoppedFrame(key: string, frame: string) {
  if (stoppedFrames.get(key) === frame) return;
  stoppedFrames.delete(key);
  stoppedFrames.set(key, frame);
  for (const oldest of stoppedFrames.keys()) {
    if (stoppedFrames.size <= LAST_FRAMES_KEPT) break;
    stoppedFrames.delete(oldest);
  }
}

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
  const frame = event?.type === "frame" ? `data:${event.mime};base64,${event.data}` : null;
  const reason = event?.type === "unavailable" ? event.reason : undefined;
  const key = stoppedFrameKey(session);
  // A stopped card mounted anew starts from the picture an earlier one of this session showed.
  const [last, setLast] = useState<string | null>(() =>
    props.stopped ? (stoppedFrames.get(key) ?? null) : null,
  );
  // Kept for a stopped session; adjusted while rendering, as the last event decides it.
  const kept = frame ?? (reason === "private" ? null : last);
  if (kept !== last) setLast(kept);
  useEffect(() => {
    if (reason === "private") stoppedFrames.delete(key);
    else if (props.stopped && last !== null) keepStoppedFrame(key, last);
  }, [key, reason, props.stopped, last]);
  const shown = frame ?? (props.stopped ? last : null);
  if (shown !== null)
    return (
      <img
        alt=""
        className={cn("size-full object-contain", props.stopped && "opacity-50 grayscale")}
        src={shown}
      />
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

/** What a card shows of its session: its picture, or a quiet placeholder. Never a private screen. */
export function PreviewSessionThumbnail(props: {
  readonly session: PreviewSession;
  readonly live: boolean;
  readonly size?: "card" | "large" | undefined;
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
  // A person's control or a secret on screen outdates any picture a stopped card kept.
  const outdated = session.owner === "private" || session.owner === "human";
  useEffect(() => {
    if (outdated) stoppedFrames.delete(stoppedFrameKey(session));
  });
  if (!interactive && session.owner === "private")
    return <Placeholder icon="lock" text="Private" />;
  // A person who took over is working in their own view; a card does not watch them.
  if (!interactive && session.owner === "human")
    return <Placeholder icon="person" text="A person is in control" />;
  // A turn the desktop gave no driver: say what a person must allow (#1399).
  if (session.status === "permission-needed")
    return (
      <Placeholder
        icon="lock"
        text={`No computer use yet. ${session.target.kind === "desktop" ? session.target.title : "Allow it"} (System Settings > Privacy & Security).`}
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
