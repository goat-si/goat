import {
  agentCursorPlacement,
  PREVIEW_SESSION_THUMBNAIL_FRAME_MS,
  PREVIEW_SESSION_THUMBNAIL_WIDTH,
} from "@goat/client-runtime/state/preview-sessions";
import type {
  PreviewSession,
  PreviewSessionFrameEvent,
  PreviewSessionNoPicture,
  PreviewSessionTarget,
} from "@goat/contracts";
import type { PreviewStreamControl } from "@goat/client-runtime/preview/server-browser-stream";
import {
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { GlobeIcon, LockIcon, MonitorIcon, MousePointerClickIcon } from "~/components/solar";
import { type ServerBrowserHandle, ServerBrowserSurface } from "~/browser/ServerBrowserSurface";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useDesktopSessionFrame } from "~/state/previewSessions";

import { AgentCursorMark } from "../AgentBrowserCursor";
import { StackDocumentContext } from "./PreviewSessionStackSurface";

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

/** Frames come every half second while a window is watched; this long without one, the picture is old. */
const FRAME_STALE_MS = 3_000;

type DesktopTarget = Extract<PreviewSessionTarget, { kind: "desktop" }>;
type DesktopFrame = Extract<PreviewSessionFrameEvent, { type: "frame" }>;

/**
 * The cursor to draw over a frame. A server that stamps capturedAt sends the cursor those pixels
 * go with, so a cursor that moved on since is not drawn over a picture that does not show it yet;
 * an older server's frames carry none, and the session's cursor is all there is.
 * Either way the list has the last word on whether one shows: a cursor it has since hidden, or a
 * person's turn, takes the frame's away at once.
 */
function frameCursor(target: DesktopTarget, frame: DesktopFrame) {
  const paired = frame.capturedAt !== undefined;
  const source = paired ? frame : target;
  const cursorState = source.cursorState;
  const listShows =
    target.cursor !== undefined &&
    target.cursorState?.phase !== "hidden" &&
    target.cursorState?.phase !== "yielded";
  const cursor =
    listShows &&
    (paired || source.cursor?.windowId === target.windowId) &&
    cursorState?.phase !== "hidden" &&
    cursorState?.phase !== "yielded"
      ? source.cursor
      : undefined;
  return { cursor, cursorState };
}

/**
 * True once the frame on show has been there well past the next one's due time while the window
 * is still watched, or it was already that old when the server sent it: the helper or the
 * connection stalled, and the picture is no longer live.
 */
function useFrameStale(frame: DesktopFrame | null) {
  const [stale, setStale] = useState<DesktopFrame | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- a frame that is not followed by another is only noticed by a timer
  useEffect(() => {
    if (frame === null) return;
    const timer = window.setTimeout(() => setStale(frame), FRAME_STALE_MS);
    return () => window.clearTimeout(timer);
  }, [frame]);
  return frame !== null && (stale === frame || (frame.ageMs ?? 0) > FRAME_STALE_MS);
}

/**
 * The agent's window, captured on its own (#1404). Frames stream only while the card shows; a
 * stopped session keeps its last frame, dimmed, and a private one keeps nothing. A picture that
 * stops updating while watched says so.
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
  const live = event?.type === "frame" ? event : null;
  const frame = live === null ? null : `data:${live.mime};base64,${live.data}`;
  const reason = event?.type === "unavailable" ? event.reason : undefined;
  // Kept for a stopped session; adjusted while rendering, as the last event decides it.
  const kept = frame ?? (reason === "private" ? null : last);
  if (kept !== last) setLast(kept);
  const shown = frame ?? (props.stopped ? last : null);
  const stale = useFrameStale(watching ? live : null);
  if (shown !== null)
    return (
      <div className="relative size-full">
        <img
          alt=""
          className={cn("size-full object-contain", props.stopped && "opacity-50 grayscale")}
          src={shown}
        />
        {props.stopped || live === null || session.target.kind !== "desktop" ? null : (
          <AgentCursor
            session={session}
            frame={{ width: live.width, height: live.height }}
            {...frameCursor(session.target, live)}
          />
        )}
        {stale ? (
          <span className="pointer-events-none absolute top-2 right-2 rounded bg-background/85 px-2 py-1 text-xs text-muted-foreground">
            Picture not updating
          </span>
        ) : null}
        {session.target.kind === "desktop" &&
        (session.target.motionSupport ?? "unsupported") === "unsupported" ? (
          <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/85 px-2 py-1 text-xs text-muted-foreground">
            Native cursor motion unavailable
          </span>
        ) : null}
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
 * on screen, with the browser's cursor mark. Positioned once per frame or resize; it moves without
 * a repeating animation, and only a move or a new phase marks it active again, never a new frame.
 */
function AgentCursor(props: {
  readonly session: PreviewSession;
  readonly frame: { readonly width: number; readonly height: number };
  readonly cursor: DesktopTarget["cursor"];
  readonly cursorState: DesktopTarget["cursorState"];
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
  const { cursor, cursorState } = props;
  const place = cursor && agentCursorPlacement(cursor, props.frame, measured);
  const ownerKey = cursorState
    ? `${cursorState.identity.runId}:${cursorState.identity.turnId}:${cursorState.identity.targetId}:${cursorState.identity.generation}:${cursorState.identity.sequence}:${cursorState.phase}`
    : cursor?.phase;
  const key = cursor ? `${cursor.point.fx}:${cursor.point.fy}:${ownerKey}` : null;
  const [mark, setMark] = useState({ key, sequence: 0 });
  if (mark.key !== key) setMark({ key, sequence: mark.sequence + 1 });
  return (
    <div ref={box} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {place === undefined || cursor === undefined ? null : (
        <AgentCursorMark
          phase={cursor.phase === "acting" ? "click" : "move"}
          {...(cursorState ? { cursorPhase: cursorState.phase } : {})}
          sequence={mark.sequence}
          left={place.left}
          top={place.top}
          controller={props.session.owner === "agent" ? "agent" : "none"}
        />
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
   * comes, so the card shows the webview itself over this picture (NativeBrowserPicture), and this
   * is what shows while it cannot: the panel or floating player holds the tab, or the cards are
   * popped out of GOAT.
   */
  readonly drawnHere?: boolean | undefined;
  /** The large browser view's stream, for Take over and Hand back. */
  readonly surfaceRef?: RefObject<ServerBrowserHandle | null> | undefined;
  readonly onStreamControl?: ((control: PreviewStreamControl | null) => void) | undefined;
}) {
  const { session } = props;
  const stackDocument = useContext(StackDocumentContext);
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
        text={
          stopped || stackDocument === null || stackDocument === document
            ? undefined
            : "Watch in GOAT"
        }
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
