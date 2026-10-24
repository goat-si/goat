import { previewSessionDetail } from "@goat/client-runtime/state/preview-sessions";
import {
  type ScopedThreadRef,
  type PreviewSession,
  type PreviewSessionControl,
  previewSessionChip,
  ThreadId,
} from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  GlobeIcon,
  MaximizeIcon,
  MonitorIcon,
  MousePointerClickIcon,
  MousePointerIcon,
  SquareIcon,
  XIcon,
} from "~/components/solar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useFaviconForThreadUrl } from "~/browserFaviconStore";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { previewSessionsEnvironment } from "~/state/previewSessions";

import { FaviconImage } from "../PreviewFaviconIcon";
import { PreviewSessionThumbnail } from "./PreviewSessionThumbnail";

type Chip = ReturnType<typeof previewSessionChip>;

/** Who holds the session, said by the dot beside the name and the picture's outline. */
const TONE: Record<Chip, { readonly dot: string; readonly ring: string }> = {
  "Agent controlling": { dot: "bg-info", ring: "ring-info/60" },
  "You're controlling": { dot: "bg-success", ring: "ring-success/60" },
  "Waiting for you": { dot: "bg-warning", ring: "ring-warning/70" },
  "Private (paused)": { dot: "bg-muted-foreground", ring: "ring-border" },
  "Permission needed": { dot: "bg-destructive", ring: "ring-destructive/60" },
  Stopped: { dot: "bg-muted-foreground/40", ring: "ring-border" },
};

const sessionName = (session: PreviewSession) =>
  session.target.title || previewSessionDetail(session);

function CornerButton(props: {
  readonly label: string;
  readonly icon: ComponentType<{ readonly className?: string }>;
  readonly corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  readonly shown: boolean;
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
              "absolute flex size-7 items-center justify-center rounded-lg bg-black/65 text-white shadow-sm outline-none backdrop-blur-sm transition-[opacity,background-color] duration-150 hover:bg-black/85 focus-visible:ring-2 focus-visible:ring-ring disabled:text-white/40 motion-reduce:transition-none",
              props.destructive && "text-red-400 hover:bg-destructive hover:text-white",
              props.corner === "top-left" && "top-2 left-2",
              props.corner === "top-right" && "top-2 right-2",
              props.corner === "bottom-left" && "bottom-2 left-2",
              props.corner === "bottom-right" && "right-2 bottom-2",
              props.shown ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
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
  /** The page's favicon or the app's icon; the session kind's icon when absent. */
  readonly icon?: ReactNode;
  /** The driving thread's title, shown with the page or app in the name's tooltip. */
  readonly threadTitle: string | null;
  readonly live: boolean;
  /** False for a read-only connection: the server would refuse its controls. */
  readonly canControl: boolean;
  readonly focused: boolean;
  readonly focusRequest: number;
  /** Opens the full preview; null where there is none, as for a desktop app. */
  readonly onExpand: (() => void) | null;
  readonly onControl: (control: PreviewSessionControl) => void;
  readonly onDismiss: () => void;
  /** A control for the whole stack, such as Pop out, beside the first card's name. */
  readonly headerAction?: ReactNode;
}

/**
 * One agent-driven browser tab or desktop app, in Aside's card: a single line naming it, then its
 * picture. Controls sit on the picture's corners and appear on hover, keyboard focus, or a tap.
 */
export function AgentScreenCardView(props: AgentScreenCardViewProps) {
  const { session } = props;
  const chip = previewSessionChip(session);
  const tone = TONE[chip];
  const stopped = session.status === "stopped";
  const name = sessionName(session);
  const detail = [previewSessionDetail(session), props.threadTitle].filter(Boolean).join(" · ");
  const card = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // A tap that reveals the controls must not also open the preview under them.
  const swallowClick = useRef(false);
  const shown = hovered || focusWithin || revealed;

  useEffect(() => {
    if (!revealed) return;
    const doc = card.current?.ownerDocument;
    if (!doc) return;
    const hide = (event: PointerEvent) => {
      if (event.target instanceof Node && card.current?.contains(event.target)) return;
      setRevealed(false);
    };
    doc.addEventListener("pointerdown", hide);
    return () => doc.removeEventListener("pointerdown", hide);
  }, [revealed]);

  // Each request scrolls again, even to the card already focused.
  const focusRequest = props.focused ? props.focusRequest : 0;
  useEffect(() => {
    if (focusRequest > 0) card.current?.scrollIntoView({ block: "nearest" });
  }, [focusRequest]);

  const reveal = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse" || shown) return;
    setRevealed(true);
    swallowClick.current = true;
  };
  const expand = () => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    props.onExpand?.();
  };
  const takeover = session.capabilities.controls.find(
    (control) => control === "takeover" || control === "handBack",
  );
  const canStop = session.capabilities.controls.includes("stop");
  const thumbnail = <PreviewSessionThumbnail session={session} live={props.live} />;

  return (
    <article
      ref={card}
      data-stack-interactive
      data-session-state={chip}
      aria-label={`${name}: ${chip}`}
      className={cn(
        // Clipped content would otherwise let the scrolling list squeeze a card instead of scrolling.
        "pointer-events-auto shrink-0 overflow-hidden rounded-2xl border bg-popover/95 p-1.5 text-popover-foreground shadow-lg backdrop-blur-sm",
        props.focused && "ring-2 ring-ring",
      )}
      onPointerEnter={(event) => event.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={(event) => event.pointerType === "mouse" && setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        )
          setFocusWithin(false);
      }}
    >
      <div className="flex h-7 items-center gap-2 px-1.5 pb-1">
        {props.icon ?? <KindIcon session={session} />}
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate font-medium text-sm" />}>
            {name}
          </TooltipTrigger>
          <TooltipPopup side="top">{detail ? `${detail} — ${chip}` : chip}</TooltipPopup>
        </Tooltip>
        {props.headerAction ? (
          <span
            className={cn(
              "flex shrink-0 transition-opacity motion-reduce:transition-none",
              shown ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            {props.headerAction}
          </span>
        ) : null}
        <span
          role="img"
          aria-label={chip}
          title={chip}
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
        {props.onExpand ? (
          <button
            type="button"
            className="block size-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={expand}
            aria-label={`Open ${name}`}
          >
            {thumbnail}
          </button>
        ) : (
          <div className="size-full">{thumbnail}</div>
        )}
        <div className="pointer-events-none absolute inset-0">
          {stopped ? (
            <CornerButton
              label="Close"
              icon={XIcon}
              corner="top-right"
              shown={shown}
              onClick={props.onDismiss}
            />
          ) : canStop ? (
            <CornerButton
              label="Stop"
              icon={SquareIcon}
              corner="top-right"
              shown={shown}
              destructive
              disabled={!props.canControl}
              onClick={() => props.onControl("stop")}
            />
          ) : null}
          {takeover ? (
            <CornerButton
              label={takeover === "takeover" ? "Take over" : "Hand back"}
              icon={takeover === "takeover" ? MousePointerClickIcon : MousePointerIcon}
              corner="bottom-left"
              shown={shown}
              disabled={!props.canControl}
              onClick={() => props.onControl(takeover)}
            />
          ) : null}
          {props.onExpand ? (
            <CornerButton
              label="Open the full preview"
              icon={MaximizeIcon}
              corner="bottom-right"
              shown={shown}
              onClick={() => props.onExpand?.()}
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** A card wired to navigation, the session's thread, and the environment's control grant. */
export function AgentScreenCard(
  props: Pick<
    AgentScreenCardViewProps,
    "session" | "live" | "focused" | "focusRequest" | "headerAction"
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
  // A browser tab's full preview is where a person takes and returns control of it.
  const expand =
    threadRef === null || browserTab === null
      ? null
      : () => {
          void navigate({ to: "/$environmentId/$threadId", params: threadRef });
          openBrowser(threadRef, browserTab);
        };
  const canControl = useAtomValue(
    previewSessionsEnvironment.control.permissionAtom(session.environmentId),
  );
  return (
    <AgentScreenCardView
      session={session}
      icon={
        threadRef && session.target.kind === "browser" ? (
          <ThreadFavicon threadRef={threadRef} url={session.target.url} />
        ) : undefined
      }
      threadTitle={thread?.title ?? null}
      live={props.live}
      canControl={canControl}
      focused={props.focused}
      focusRequest={props.focusRequest}
      onExpand={expand}
      onControl={(control) =>
        session.kind === "browser" &&
        control !== "stop" &&
        !(control === "handBack" && session.status === "stopped")
          ? expand?.()
          : props.onControl(control)
      }
      onDismiss={props.onDismiss}
      headerAction={props.headerAction}
    />
  );
}
