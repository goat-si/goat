import {
  orderPreviewSessions,
  previewSessionControlUsesBrowser,
  previewSessionDetail,
} from "@goat/client-runtime/state/preview-sessions";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  type PreviewSession,
  type PreviewSessionControl,
  previewSessionChip,
  ThreadId,
} from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  ChevronDownIcon,
  ChevronUpIcon,
  GlobeIcon,
  MaximizeIcon,
  MonitorIcon,
  SquareIcon,
} from "~/components/solar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { previewSessionsEnvironment, usePreviewSessions } from "~/state/previewSessions";
import { useAtomCommand } from "~/state/use-atom-command";

import { PreviewSessionStackSurface } from "./PreviewSessionStackSurface";
import { PreviewSessionThumbnail } from "./PreviewSessionThumbnail";
import { openPreviewSessionStack, usePreviewSessionStack } from "./previewSessionStackStore";

const CHIP_VARIANT = {
  "Agent controlling": "info",
  "You're controlling": "success",
  "Private (paused)": "warning",
  "Waiting for you": "warning",
  Stopped: "secondary",
  "Permission needed": "error",
} as const;

const CONTROL_LABEL: Partial<Record<PreviewSessionControl, string>> = {
  takeover: "Take over",
  handBack: "Hand back",
};

function PreviewSessionTile(props: {
  readonly session: PreviewSession;
  readonly focused: boolean;
  readonly focusRequest: number;
  readonly live: boolean;
  readonly onControl: (control: PreviewSessionControl) => void;
}) {
  const { session } = props;
  const navigate = useNavigate();
  const openBrowser = useRightPanelStore((state) => state.openBrowser);
  const threadRef =
    session.threadId === undefined
      ? null
      : { environmentId: session.environmentId, threadId: ThreadId.make(session.threadId) };
  const thread = useThreadShell(threadRef);
  const chip = previewSessionChip(session);
  const browserTab = session.target.kind === "browser" ? session.target.tabId : null;
  // A browser tab's full preview is where a person takes and returns control of it.
  const expand =
    threadRef === null || browserTab === null
      ? null
      : () => {
          void navigate({ to: "/$environmentId/$threadId", params: threadRef });
          openBrowser(threadRef, browserTab);
        };
  const act = (control: PreviewSessionControl) =>
    previewSessionControlUsesBrowser(session, control) ? expand?.() : props.onControl(control);
  const actions = session.capabilities.controls.filter((control) => control in CONTROL_LABEL);
  // Read-only connections see the tile but not controls the server would refuse.
  const canControl = useAtomValue(
    previewSessionsEnvironment.control.permissionAtom(session.environmentId),
  );
  const tile = useRef<HTMLElement>(null);
  // Each request scrolls again, even to the tile already focused.
  const focusRequest = props.focused ? props.focusRequest : 0;
  useEffect(() => {
    if (focusRequest > 0) tile.current?.scrollIntoView({ block: "nearest" });
  }, [focusRequest]);
  return (
    <article
      ref={tile}
      data-stack-interactive
      className={cn(
        // Clipped content would otherwise let the scrolling list squeeze a tile instead of scrolling.
        "pointer-events-auto shrink-0 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-sm",
        props.focused && "ring-2 ring-ring",
      )}
      aria-label={`${session.target.title || previewSessionDetail(session)}: ${chip}`}
    >
      <div className="flex items-center gap-2 px-2.5 pt-2">
        {session.kind === "browser" ? (
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-xs">
          {session.target.title || previewSessionDetail(session)}
        </span>
        <Badge variant={CHIP_VARIANT[chip]} size="sm">
          {chip}
        </Badge>
      </div>
      <p className="truncate px-2.5 pt-0.5 text-muted-foreground text-xs">
        {previewSessionDetail(session)}
        {thread ? ` · ${thread.title}` : ""}
      </p>
      <button
        type="button"
        className="relative m-2 mb-0 block aspect-[16/10] w-[calc(100%-1rem)] overflow-hidden rounded-md bg-muted disabled:cursor-default"
        disabled={expand === null}
        onClick={() => expand?.()}
        aria-label={expand === null ? undefined : "Open the full preview"}
      >
        <PreviewSessionThumbnail session={session} live={props.live} />
        {expand === null ? null : (
          <MaximizeIcon className="absolute top-1.5 right-1.5 size-3.5 text-muted-foreground" />
        )}
      </button>
      <div className="flex items-center gap-1.5 p-2">
        {actions.map((control) => (
          <Button
            key={control}
            variant="outline"
            size="compact"
            disabled={!canControl}
            onClick={() => act(control)}
          >
            {CONTROL_LABEL[control]}
          </Button>
        ))}
        {session.capabilities.controls.includes("stop") ? (
          <Button
            className="ml-auto"
            variant="destructive-outline"
            size="compact"
            disabled={!canControl}
            onClick={() => props.onControl("stop")}
          >
            <SquareIcon />
            Stop
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** The stack's top edge (`top-14`) plus the gap it keeps above the mini player, in px. */
const STACK_TOP_PX = 56;
const STACK_GAP_PX = 8;
/** `w-72` and `right-3`: a mini player left of this edge does not sit under the stack. */
const STACK_SPAN_PX = 300;

/**
 * Where the mini player starts when it sits under the stack, so the stack ends above it. Its
 * frame depends on the page it shows and the composer, so it is measured, again whenever it is
 * resized or moved.
 */
function useMiniPlayerTop(frame: unknown) {
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    const player = frame === null ? null : document.querySelector("[data-preview-mini-player]");
    if (player === null) return;
    const measure = () => {
      const rect = player.getBoundingClientRect();
      setTop(rect.right > window.innerWidth - STACK_SPAN_PX ? rect.top : null);
    };
    // Observing delivers the current size first, which measures it once.
    const stopObserving = observeResize(player, measure);
    window.addEventListener("resize", measure);
    return () => {
      stopObserving();
      window.removeEventListener("resize", measure);
    };
  }, [frame]);
  return frame === null ? null : top;
}

function StopAllButton(props: {
  readonly environmentId: EnvironmentId;
  readonly onStop: () => void;
}) {
  const canControl = useAtomValue(
    previewSessionsEnvironment.control.permissionAtom(props.environmentId),
  );
  return (
    <Button
      variant="destructive-outline"
      size="compact"
      disabled={!canControl}
      onClick={props.onStop}
    >
      Stop all
    </Button>
  );
}

/**
 * The right-side stack of what agents drive on this environment's host: one tile per browser
 * tab or desktop session, waiting ones first. Thumbnails stream only while the stack is open and
 * the window visible (D11, #1215).
 */
export function PreviewSessionStack(props: {
  readonly environmentId: EnvironmentId | null;
  /** The thread on screen; its mini player already shows one of its tabs. */
  readonly threadRef: ScopedThreadRef | null;
}) {
  // An open right panel is the expanded view; the stack steps aside until it closes.
  const panelOpen = useRightPanelStore((state) =>
    props.threadRef ? selectActiveRightPanel(state.byThreadKey, props.threadRef) !== null : false,
  );
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    props.threadRef ? selectThreadPreviewMiniPlayer(state.byThreadKey, props.threadRef) : null,
  );
  const shownTab = miniPlayer?.source.kind === "browser" ? miniPlayer.source.tabId : null;
  const sessions = orderPreviewSessions(usePreviewSessions(props.environmentId)).filter(
    (session) =>
      !(
        shownTab !== null &&
        session.threadId === props.threadRef?.threadId &&
        session.target.kind === "browser" &&
        session.target.tabId === shownTab
      ),
  );
  const control = useAtomCommand(previewSessionsEnvironment.control);
  const collapsed = usePreviewSessionStack((state) => state.collapsed);
  const setCollapsed = usePreviewSessionStack((state) => state.setCollapsed);
  const focus = usePreviewSessionStack((state) => state.focus);
  const focusRequest = usePreviewSessionStack((state) => state.focusRequest);
  const miniPlayerTop = useMiniPlayerTop(miniPlayer);
  const focusedId =
    focus === null
      ? null
      : (sessions.find((session) =>
          focus.sessionId === undefined
            ? session.kind === focus.kind
            : session.id === focus.sessionId,
        )?.id ?? null);

  const environmentId = props.environmentId;
  const send = (input: { readonly sessionId?: string; readonly control: PreviewSessionControl }) =>
    environmentId === null ? undefined : void control({ environmentId, input });
  return (
    <PreviewSessionStackSurface
      hasContent={environmentId !== null && sessions.length > 0}
      dockedHidden={panelOpen}
    >
      {({ floating, live, maxHeight, toggle, captureNotice }) => (
        <aside
          className={
            floating
              ? "pointer-events-none flex w-72 flex-col gap-2"
              : "pointer-events-none fixed top-14 right-3 z-40 flex max-h-[calc(100vh-5rem)] w-72 flex-col gap-2"
          }
          // The mini player keeps its corner; the stack ends above it and scrolls.
          style={
            floating
              ? { maxHeight }
              : miniPlayerTop === null
                ? undefined
                : { maxHeight: Math.max(0, miniPlayerTop - STACK_TOP_PX - STACK_GAP_PX) }
          }
          aria-label="Agents on screen"
        >
          <div
            data-stack-interactive
            className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-lg border bg-popover px-2 py-1.5 shadow-sm"
          >
            <span className="flex-1 font-medium text-xs">
              Agents on screen <span className="text-muted-foreground">{sessions.length}</span>
            </span>
            {toggle}
            {environmentId === null ? null : (
              <StopAllButton
                environmentId={environmentId}
                onStop={() => send({ control: "stopAll" })}
              />
            )}
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={collapsed ? "Show agent sessions" : "Hide agent sessions"}
              aria-expanded={!collapsed}
              onClick={() => (collapsed ? openPreviewSessionStack() : setCollapsed(true))}
            >
              {collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
            </Button>
          </div>
          {captureNotice ? (
            <p
              data-stack-interactive
              className="pointer-events-auto rounded-lg border bg-popover p-2 text-xs text-muted-foreground"
            >
              {captureNotice}
            </p>
          ) : null}
          {collapsed ? null : (
            <div className="pointer-events-none flex min-h-0 flex-col gap-2 overflow-y-auto">
              {sessions.map((session) => (
                <PreviewSessionTile
                  key={session.id}
                  focused={session.id === focusedId}
                  focusRequest={focusRequest}
                  session={session}
                  live={live}
                  onControl={(next) => send({ sessionId: session.id, control: next })}
                />
              ))}
            </div>
          )}
        </aside>
      )}
    </PreviewSessionStackSurface>
  );
}
