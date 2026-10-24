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
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

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
import { cn } from "~/lib/utils";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { previewSessionsEnvironment, usePreviewSessions } from "~/state/previewSessions";
import { useAtomCommand } from "~/state/use-atom-command";

import { PreviewSessionThumbnail, useDocumentVisible } from "./PreviewSessionThumbnail";

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
  return (
    <article
      className="overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-sm"
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
          <Button key={control} variant="outline" size="compact" onClick={() => act(control)}>
            {CONTROL_LABEL[control]}
          </Button>
        ))}
        {session.capabilities.controls.includes("stop") ? (
          <Button
            className="ml-auto"
            variant="destructive-outline"
            size="compact"
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
  const [collapsed, setCollapsed] = useState(false);
  const visible = useDocumentVisible();
  if (props.environmentId === null || sessions.length === 0 || panelOpen) return null;
  const environmentId = props.environmentId;
  const send = (input: { readonly sessionId?: string; readonly control: PreviewSessionControl }) =>
    void control({ environmentId, input });
  return (
    <aside
      className={cn(
        "pointer-events-none fixed top-14 right-3 z-40 flex w-72 flex-col gap-2",
        // The mini player keeps the lower right; the stack ends above where it opens.
        miniPlayer ? "max-h-[calc(100vh-30rem)]" : "max-h-[calc(100vh-5rem)]",
      )}
      aria-label="Agents on screen"
    >
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-lg border bg-popover px-2 py-1.5 shadow-sm">
        <span className="flex-1 font-medium text-xs">
          Agents on screen <span className="text-muted-foreground">{sessions.length}</span>
        </span>
        <Button
          variant="destructive-outline"
          size="compact"
          onClick={() => send({ control: "stopAll" })}
        >
          Stop all
        </Button>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={collapsed ? "Show agent sessions" : "Hide agent sessions"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </Button>
      </div>
      {collapsed ? null : (
        <div className="pointer-events-auto flex min-h-0 flex-col gap-2 overflow-y-auto">
          {sessions.map((session) => (
            <PreviewSessionTile
              key={session.id}
              session={session}
              live={visible}
              onControl={(next) => send({ sessionId: session.id, control: next })}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
