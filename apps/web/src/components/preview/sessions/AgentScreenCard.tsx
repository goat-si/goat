import { previewSessionDetail } from "@goat/client-runtime/state/preview-sessions";
import type { PreviewStreamControl } from "@goat/client-runtime/preview/server-browser-stream";
import {
  AuthPreviewOperateScope,
  type PreviewSession,
  type PreviewSessionControl,
  previewSessionChip,
  type ScopedThreadRef,
  ThreadId,
} from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import type { ServerBrowserHandle } from "~/browser/ServerBrowserSurface";
import { useRendersServerTabNatively } from "~/browser/previewRuntime";
import { useFaviconForThreadUrl } from "~/browserFaviconStore";
import {
  GlobeIcon,
  MaximizeIcon,
  MinimizeIcon,
  MonitorIcon,
  MousePointerClickIcon,
  MousePointerIcon,
  SquareIcon,
  XIcon,
} from "~/components/solar";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { previewSessionsEnvironment } from "~/state/previewSessions";
import { useEnvironmentScope } from "~/state/session";

import { FaviconImage } from "../PreviewFaviconIcon";
import { BrowserCardActions } from "./BrowserCardActions";
import { NativeBrowserPicture, useHostedTab } from "./NativeBrowserPicture";
import { PreviewSessionThumbnail } from "./PreviewSessionThumbnail";
import { StackDocumentContext } from "./PreviewSessionStackSurface";

type Chip = ReturnType<typeof previewSessionChip>;

/** Agent sessions list only server tabs; this asks whether this client draws one natively. */
const SERVER_TAB = { runtime: "server" } as const;

/** Who holds the session, said by the dot beside the name and the picture's outline. */
const TONE: Record<Chip, { readonly dot: string; readonly ring: string }> = {
  "Agent controlling": { dot: "bg-info", ring: "ring-info/60" },
  "You're controlling": { dot: "bg-success", ring: "ring-success/60" },
  "Waiting for you": { dot: "bg-warning", ring: "ring-warning/70" },
  "Private (paused)": { dot: "bg-muted-foreground", ring: "ring-border" },
  "Permission needed": { dot: "bg-destructive", ring: "ring-destructive/60" },
  Stopped: { dot: "bg-muted-foreground/40", ring: "ring-border" },
};

/**
 * Faded and inert until the card is hovered or holds focus. CSS knows both exactly, even when the
 * focused control is swapped out (Enlarge, Shrink) and no blur event fires.
 */
const HIDDEN_UNTIL_HOVER =
  "pointer-events-none opacity-0 group-hover/card:pointer-events-auto group-hover/card:opacity-100 group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100";
/**
 * Over a webview the pointer never reaches the card, so a hidden control stays hit-testable: the
 * pointer reaching a corner reveals the picture's controls, as the floating player's corner did.
 */
const HIDDEN_OVER_WEBVIEW =
  "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 focus-visible:opacity-100";

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const CORNER: Record<Corner, string> = {
  "top-left": "top-2 left-2",
  "top-right": "top-2 right-2",
  "bottom-left": "bottom-2 left-2",
  "bottom-right": "right-2 bottom-2",
};

function CornerButton(props: {
  readonly label: string;
  readonly icon: ComponentType<{ readonly className?: string }>;
  readonly corner: Corner;
  readonly shown: boolean;
  /** Drawn in the layer above a tab's webview, outside the card. */
  readonly overWebview?: boolean;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
            className={cn(
              // 28px targets, 8px in from each corner: Stop and Take over sit at opposite corners.
              "absolute flex size-7 items-center justify-center rounded-lg bg-black/65 text-white shadow-sm outline-none backdrop-blur-sm transition-[opacity,background-color] duration-150 hover:bg-black/85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:text-white/40 motion-reduce:transition-none",
              props.destructive && "text-destructive hover:bg-destructive hover:text-white",
              CORNER[props.corner],
              props.shown
                ? "pointer-events-auto opacity-100"
                : props.overWebview
                  ? cn("pointer-events-auto", HIDDEN_OVER_WEBVIEW)
                  : HIDDEN_UNTIL_HOVER,
            )}
          />
        }
      >
        <Icon className={cn("size-3.5", props.destructive && "fill-current")} />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const KindIcon = (props: { readonly session: PreviewSession }) =>
  props.session.kind === "browser" ? (
    <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
  );

/** The page's favicon as the thread's browser recorded it; the server's URL may not load here. */
function ThreadFavicon(props: { readonly threadRef: ScopedThreadRef; readonly url: string }) {
  const favicon = useFaviconForThreadUrl(props.threadRef, props.url);
  return (
    <FaviconImage
      sources={[favicon]}
      fallback={<GlobeIcon className="size-4 shrink-0 text-muted-foreground" />}
      className="size-4 shrink-0 rounded-sm"
    />
  );
}

export interface AgentScreenCardViewProps {
  readonly session: PreviewSession;
  /**
   * card: Aside's small card. large: the same card grown for watching and taking control; a
   * browser tab's picture is then its live, interactive stream. Both keep a 16:10 picture.
   */
  readonly size?: "card" | "large" | undefined;
  /** The card's width in px; its height follows from the picture's aspect. */
  readonly width?: number | undefined;
  /** The page's favicon; the session kind's icon when absent. */
  readonly icon?: ReactNode | undefined;
  /** The driving thread's title: a desktop card's name, and part of every name's tooltip. */
  readonly threadTitle: string | null;
  readonly live: boolean;
  /** Stop and the desktop's Take over / Hand back: the session controls grant. */
  readonly canControl: boolean;
  /** Taking over a browser tab: the preview grant, checked by the tab's stream. */
  readonly canOperateBrowser: boolean;
  /** A browser tab this desktop draws itself in a webview instead of streaming it. */
  readonly drawnHere?: boolean | undefined;
  /** The drawn tab's hosted webview, which the card shows as its picture; null until hosted. */
  readonly hosted?: {
    readonly runtimeTabId: string;
    readonly overlay: DesktopPreviewOverlay | null;
  } | null;
  /** Changes whenever the stack moves this card without resizing it. */
  readonly layoutVersion?: string | undefined;
  readonly focused: boolean;
  readonly focusRequest: number;
  /** Take control of the browser stream as soon as the large view connects. */
  readonly takeOverOnOpen?: boolean | undefined;
  readonly onTakeOverStarted?: (() => void) | undefined;
  /** Shows this session at the large size; takeOver asks for the browser tab's control there. */
  readonly onExpand: (options?: { readonly takeOver?: boolean }) => void;
  /** Returns the large view to a card. */
  readonly onCollapse?: (() => void) | undefined;
  /** Opens the browser tab in the thread's right panel; null where there is none. */
  readonly onOpenInPanel?: (() => void) | null | undefined;
  readonly onControl: (control: PreviewSessionControl) => void;
  readonly onDismiss: () => void;
  /** A control for the whole stack, such as Pop out, beside the first card's name. */
  readonly headerAction?: ReactNode | undefined;
}

/**
 * One agent-driven browser tab or desktop app, in Aside's card: a single line naming it, then its
 * picture. Controls sit on the picture's corners and appear on hover, keyboard focus, or a tap.
 */
export function AgentScreenCardView(props: AgentScreenCardViewProps) {
  const { session } = props;
  const large = props.size === "large";
  const chip = previewSessionChip(session);
  const tone = TONE[chip];
  const stopped = session.status === "stopped";
  const browser = session.kind === "browser";
  const name =
    (!browser ? props.threadTitle : null) || session.target.title || previewSessionDetail(session);
  const detail = [previewSessionDetail(session), browser ? props.threadTitle : null]
    .filter(Boolean)
    .join(" · ");
  const card = useRef<HTMLElement>(null);
  const surface = useRef<ServerBrowserHandle | null>(null);
  // A touch screen has no hover: the first tap reveals the controls.
  const [revealed, setRevealed] = useState(false);
  const [stream, setStream] = useState<PreviewStreamControl | null>(null);
  // A takeover asked for and not yet answered by the stream.
  const pendingTakeover = useRef(false);
  // A tap that reveals the controls must not also open the preview under them.
  const swallowClick = useRef(false);
  const shown = revealed;
  const stackDocument = useContext(StackDocumentContext);
  // Popped out over other apps, the card lives in another window, where no webview can be shown.
  const floating = stackDocument !== null && stackDocument !== document;
  const hosted = browser && props.drawnHere && !floating ? (props.hosted ?? null) : null;

  useEffect(() => {
    if (!revealed) return;
    // The stack can move the card to the floating window's document while it stays mounted.
    const doc = stackDocument ?? card.current?.ownerDocument;
    if (!doc) return;
    const hide = (event: PointerEvent) => {
      if (event.target instanceof Node && card.current?.contains(event.target)) return;
      setRevealed(false);
    };
    doc.addEventListener("pointerdown", hide);
    return () => doc.removeEventListener("pointerdown", hide);
  }, [revealed, stackDocument]);

  // Each request scrolls again, even to the card already focused.
  const focusRequest = props.focused ? props.focusRequest : 0;
  useEffect(() => {
    if (focusRequest > 0) card.current?.scrollIntoView({ block: "nearest" });
  }, [focusRequest]);

  const takeBrowserControl = () => {
    pendingTakeover.current = true;
    surface.current?.takeControl();
  };
  const onStreamControl = (next: PreviewStreamControl | null) => {
    setStream(next);
    if (next === null) return;
    if (large && props.takeOverOnOpen && next.controller !== "you" && next.canOperate) {
      props.onTakeOverStarted?.();
      takeBrowserControl();
      return;
    }
    if (!pendingTakeover.current || next.controller === "agent") return;
    pendingTakeover.current = false;
    if (next.controller === "you") return;
    toastManager.add({
      type: "error",
      title:
        next.controller === "another-viewer"
          ? "Someone else controls this tab"
          : "This connection cannot control the browser",
    });
  };

  const reveal = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse" || shown) return;
    setRevealed(true);
    // The large view's taps go to the page; a card's first tap only reveals.
    if (!large) swallowClick.current = true;
  };
  const expand = () => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    enlarge();
  };
  // A drawn tab cannot show in the popped-out window; the right panel in GOAT shows it.
  const enlarge = () =>
    floating && props.drawnHere && props.onOpenInPanel ? props.onOpenInPanel() : props.onExpand();
  const collapse = () => {
    // The card is a passive view; control goes back to the agent before it shrinks.
    if (stream?.controller === "you") surface.current?.releaseControl();
    props.onCollapse?.();
  };

  const desktopTakeover = session.capabilities.controls.find(
    (control) => control === "takeover" || control === "handBack",
  );
  const youControl = browser && large && stream?.controller === "you";
  // A tab this desktop draws has no stream to take control through; the floating player shows it.
  const takeover =
    stopped || props.drawnHere
      ? null
      : browser
        ? youControl
          ? "browser-release"
          : "browser-take"
        : desktopTakeover === undefined
          ? null
          : "desktop";
  const takeoverLabel =
    takeover === "browser-release" || (takeover === "desktop" && desktopTakeover === "handBack")
      ? "Hand back"
      : "Take over";
  const takeoverDisabled =
    takeover === "browser-take"
      ? !props.canOperateBrowser || (large && stream?.controller === "another-viewer")
      : takeover === "desktop" && !props.canControl;
  const runTakeover = () => {
    if (takeover === "browser-release") surface.current?.releaseControl();
    else if (takeover === "browser-take") {
      if (large) takeBrowserControl();
      else props.onExpand({ takeOver: true });
    } else if (takeover === "desktop" && desktopTakeover !== undefined)
      props.onControl(desktopTakeover);
  };
  const canStop = session.capabilities.controls.includes("stop");
  const thumbnail = (
    <PreviewSessionThumbnail
      session={session}
      live={props.live}
      size={large ? "large" : "card"}
      drawnHere={props.drawnHere}
      surfaceRef={surface}
      onStreamControl={onStreamControl}
    />
  );
  // The picture's corners match every agent screen; a browser card closes from its header.
  const corners = ({ overWebview }: { readonly overWebview: boolean }) => (
    <>
      {!large && overWebview ? (
        // A card is a passive view: a click on its webview enlarges it instead of reaching the page.
        <button
          type="button"
          className="pointer-events-auto absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={expand}
          onPointerDown={reveal}
          aria-label={`Open ${name}`}
        />
      ) : null}
      {stopped && !browser ? (
        <CornerButton
          label="Close"
          icon={XIcon}
          corner="top-right"
          shown={shown}
          overWebview={overWebview}
          onClick={props.onDismiss}
        />
      ) : canStop ? (
        <CornerButton
          label="Stop"
          icon={SquareIcon}
          corner="top-right"
          shown={shown}
          overWebview={overWebview}
          destructive
          disabled={!props.canControl}
          onClick={() => props.onControl("stop")}
        />
      ) : null}
      {takeover === null ? null : (
        <CornerButton
          label={takeoverLabel}
          icon={takeoverLabel === "Take over" ? MousePointerClickIcon : MousePointerIcon}
          corner="bottom-left"
          shown={shown}
          overWebview={overWebview}
          disabled={takeoverDisabled}
          onClick={runTakeover}
        />
      )}
      {large ? (
        <CornerButton
          label="Shrink to a card"
          icon={MinimizeIcon}
          corner="top-left"
          shown={shown}
          overWebview={overWebview}
          onClick={collapse}
        />
      ) : (
        <CornerButton
          label="Enlarge"
          icon={MaximizeIcon}
          corner="bottom-right"
          shown={shown}
          overWebview={overWebview}
          onClick={enlarge}
        />
      )}
    </>
  );
  const picture = large ? (
    <div className="size-full">{thumbnail}</div>
  ) : (
    <button
      type="button"
      className="block size-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={expand}
      aria-label={`Open ${name}`}
    >
      {thumbnail}
    </button>
  );

  return (
    <article
      ref={card}
      data-stack-interactive
      data-session-state={chip}
      data-size={large ? "large" : "card"}
      aria-label={`${name}: ${chip}`}
      style={props.width === undefined ? undefined : { width: props.width }}
      // Clipped content would otherwise let the scrolling list squeeze a card instead of scrolling.
      className="group/card pointer-events-auto shrink-0 overflow-hidden rounded-2xl border bg-popover/95 p-1.5 text-popover-foreground shadow-lg backdrop-blur-sm"
    >
      <div className="flex h-7 items-center gap-2 px-1.5 pb-1">
        {props.icon ?? <KindIcon session={session} />}
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate font-medium text-sm" />}>
            {name}
          </TooltipTrigger>
          <TooltipPopup side="top">{detail ? `${detail} · ${chip}` : chip}</TooltipPopup>
        </Tooltip>
        {props.headerAction || browser ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-0.5 transition-opacity motion-reduce:transition-none",
              shown ? "opacity-100" : HIDDEN_UNTIL_HOVER,
            )}
          >
            {browser ? (
              <BrowserCardActions
                session={session}
                hosted={hosted}
                canvas={() => surface.current?.canvas() ?? null}
                onOpenInPanel={
                  props.onOpenInPanel
                    ? () => {
                        collapse();
                        props.onOpenInPanel?.();
                      }
                    : null
                }
                onClose={props.onDismiss}
              />
            ) : null}
            {props.headerAction}
          </span>
        ) : null}
        <span
          role="img"
          aria-label={chip}
          className={cn("size-2 shrink-0 rounded-full", tone.dot)}
        />
      </div>
      <div
        className={cn(
          "relative aspect-[16/10] overflow-hidden rounded-xl bg-muted ring-1 ring-inset",
          tone.ring,
        )}
        onPointerDown={reveal}
      >
        {hosted ? (
          <NativeBrowserPicture
            hosted={hosted}
            live={props.live}
            layoutVersion={`${props.layoutVersion ?? ""}|${large ? "large" : "card"}`}
            ringClassName={tone.ring}
            controls={corners}
            fallback={picture}
          />
        ) : (
          <>
            {picture}
            {corners({ overWebview: false })}
          </>
        )}
      </div>
    </article>
  );
}

/** A card wired to navigation, the session's thread, and the environment's grants. */
export function AgentScreenCard(
  props: Pick<
    AgentScreenCardViewProps,
    | "session"
    | "size"
    | "width"
    | "live"
    | "focused"
    | "focusRequest"
    | "headerAction"
    | "takeOverOnOpen"
    | "onTakeOverStarted"
    | "onExpand"
    | "onCollapse"
    | "layoutVersion"
  > & {
    readonly onControl: (control: PreviewSessionControl) => void;
    readonly onDismiss: () => void;
  },
) {
  const { session } = props;
  const navigate = useNavigate();
  const openBrowser = useRightPanelStore((state) => state.openBrowser);
  const threadRef =
    session.threadId === undefined
      ? null
      : { environmentId: session.environmentId, threadId: ThreadId.make(session.threadId) };
  const thread = useThreadShell(threadRef);
  const browserTab = session.target.kind === "browser" ? session.target.tabId : null;
  const openInPanel =
    threadRef === null || browserTab === null
      ? null
      : () => {
          void navigate({ to: "/$environmentId/$threadId", params: threadRef });
          openBrowser(threadRef, browserTab);
        };
  const canControl = useAtomValue(
    previewSessionsEnvironment.control.permissionAtom(session.environmentId),
  );
  const canOperateBrowser = useEnvironmentScope(session.environmentId, AuthPreviewOperateScope);
  const drawnHere =
    useRendersServerTabNatively(session.environmentId, SERVER_TAB) && browserTab !== null;
  const hosted = useHostedTab(session);
  return (
    <AgentScreenCardView
      session={session}
      size={props.size}
      width={props.width}
      icon={
        threadRef && session.target.kind === "browser" ? (
          <ThreadFavicon threadRef={threadRef} url={session.target.url} />
        ) : undefined
      }
      threadTitle={thread?.title ?? null}
      live={props.live}
      canControl={canControl}
      canOperateBrowser={canOperateBrowser}
      drawnHere={drawnHere}
      hosted={drawnHere ? hosted : null}
      layoutVersion={props.layoutVersion}
      focused={props.focused}
      focusRequest={props.focusRequest}
      takeOverOnOpen={props.takeOverOnOpen}
      onTakeOverStarted={props.onTakeOverStarted}
      onExpand={props.onExpand}
      onCollapse={props.onCollapse}
      onOpenInPanel={openInPanel}
      onControl={props.onControl}
      onDismiss={props.onDismiss}
      headerAction={props.headerAction}
    />
  );
}
