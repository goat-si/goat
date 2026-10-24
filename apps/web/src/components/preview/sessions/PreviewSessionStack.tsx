import { scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentId, PreviewSessionControl, ScopedThreadRef } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

import { SquareIcon } from "~/components/solar";
import { Button } from "~/components/ui/button";
import {
  previewMiniPlayerSourceKey,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { previewSessionsEnvironment } from "~/state/previewSessions";
import { useAtomCommand } from "~/state/use-atom-command";

import { AgentScreenCard } from "./AgentScreenCard";
import { PreviewSessionStackSurface } from "./PreviewSessionStackSurface";
import { useDocumentVisible } from "./PreviewSessionThumbnail";
import {
  matchesFocus,
  selectAgentCardsShown,
  usePreviewSessionStack,
} from "./previewSessionStackStore";
import {
  AGENT_CARD_WIDTH_PX,
  useAgentCardsPlacement,
  useAgentScreenSessions,
  useStopAllAgents,
} from "./useAgentScreenCards";

/** Stop all where the header is out of reach: in the window popped out over other apps. */
function FloatingStopAll(props: { readonly environmentId: EnvironmentId }) {
  const stopAll = useStopAllAgents(props.environmentId);
  const canControl = useAtomValue(
    previewSessionsEnvironment.control.permissionAtom(props.environmentId),
  );
  return (
    <Button
      variant="ghost-destructive"
      size="icon-xs"
      aria-label="Stop all agents on screen"
      title="Stops every agent using the screen now"
      disabled={!canControl}
      onClick={() => void stopAll()}
    >
      <SquareIcon />
    </Button>
  );
}

/**
 * What agents drive on this environment's host, one card per browser tab or desktop thread,
 * waiting ones first, at the thread pane's top right where the floating mini player starts. One
 * session at a time can be enlarged in place. The cards hide when the pane has no room beside the
 * conversation, and the header's toggle shows or hides them. Pictures stream only while cards show
 * and the window is visible (D11, #1215).
 */
export function PreviewSessionStack(props: {
  readonly environmentId: EnvironmentId | null;
  /** The thread on screen; its mini player already shows one of its tabs. */
  readonly threadRef: ScopedThreadRef | null;
}) {
  const threadKey = props.threadRef ? scopedThreadKey(props.threadRef) : null;
  // An open right panel is the expanded view; the cards step aside until it closes.
  const panelOpen = useRightPanelStore((state) =>
    props.threadRef ? selectActiveRightPanel(state.byThreadKey, props.threadRef) !== null : false,
  );
  const detailsOpen = useRightPanelStore((state) =>
    threadKey === null ? false : state.threadPanelVisibilityByThreadKey[threadKey]?.inlineOpen,
  );
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    props.threadRef ? selectThreadPreviewMiniPlayer(state.byThreadKey, props.threadRef) : null,
  );
  const sessions = useAgentScreenSessions(props.environmentId, props.threadRef);
  const control = useAtomCommand(previewSessionsEnvironment.control);
  const shown = usePreviewSessionStack(selectAgentCardsShown);
  const dismiss = usePreviewSessionStack((state) => state.dismiss);
  const expand = usePreviewSessionStack((state) => state.expand);
  const collapse = usePreviewSessionStack((state) => state.collapse);
  const expanded = usePreviewSessionStack((state) => state.expanded);
  const focus = usePreviewSessionStack((state) => state.focus);
  const focusRequest = usePreviewSessionStack((state) => state.focusRequest);
  const probe = useRef<HTMLDivElement>(null);
  const documentVisible = useDocumentVisible();
  // Browser tabs whose large view should take control once its stream connects.
  const [takeOver, setTakeOver] = useState<ReadonlySet<string>>(() => new Set());
  const layout = useAgentCardsPlacement(
    probe,
    [
      threadKey ?? "",
      miniPlayer ? previewMiniPlayerSourceKey(miniPlayer.source) : "",
      detailsOpen === true,
    ].join("|"),
    props.environmentId !== null && sessions.length > 0 && !panelOpen,
    shown && documentVisible,
  );
  const focusedId =
    focus === null ? null : (sessions.find((session) => matchesFocus(session, focus))?.id ?? null);
  const large =
    expanded === null || layout?.large === null
      ? null
      : (sessions.find(
          (session) =>
            (expanded.environmentId === undefined ||
              session.environmentId === expanded.environmentId) &&
            matchesFocus(session, expanded),
        ) ?? null);
  const column = (large !== null ? layout?.large : null) ?? layout?.card;

  const environmentId = props.environmentId;
  const send = (input: { readonly sessionId?: string; readonly control: PreviewSessionControl }) =>
    environmentId === null ? undefined : void control({ environmentId, input });
  return (
    <>
      {/* Resolves the conversation's width setting, which decides whether a card fits beside it. */}
      <div
        ref={probe}
        aria-hidden
        className="pointer-events-none invisible fixed top-0 left-0 h-0 w-(--chat-content-max-width)"
      />
      <PreviewSessionStackSurface
        hasContent={environmentId !== null && sessions.length > 0}
        dockedHidden={panelOpen || !shown || layout === null}
      >
        {({ floating, live, maxHeight, toggle, captureNotice }) => (
          <aside
            className={
              floating
                ? "pointer-events-none flex flex-col items-end gap-2"
                : "pointer-events-none fixed z-40 flex flex-col items-end gap-2"
            }
            style={
              floating || column === undefined
                ? { maxHeight }
                : { top: column.top, right: column.right, maxHeight: column.maxHeight }
            }
            aria-label="Agents on screen"
          >
            {captureNotice ? (
              <p
                data-stack-interactive
                className="pointer-events-auto rounded-2xl border bg-popover p-2 text-xs text-muted-foreground"
                style={{ width: AGENT_CARD_WIDTH_PX }}
              >
                {captureNotice}
              </p>
            ) : null}
            <div className="pointer-events-none flex min-h-0 flex-col items-end gap-2 overflow-y-auto">
              {sessions.map((session, index) => {
                const enlarged = !floating && session.id === large?.id;
                return (
                  <AgentScreenCard
                    key={session.id}
                    size={enlarged ? "large" : "card"}
                    width={enlarged && layout?.large ? layout.large.width : AGENT_CARD_WIDTH_PX}
                    focused={session.id === focusedId}
                    focusRequest={focusRequest}
                    session={session}
                    live={live}
                    takeOverOnOpen={enlarged && takeOver.has(session.id)}
                    onTakeOverStarted={() =>
                      setTakeOver((current) => {
                        const next = new Set(current);
                        next.delete(session.id);
                        return next;
                      })
                    }
                    headerAction={
                      index === 0 && (toggle !== null || floating) ? (
                        <>
                          {toggle}
                          {floating && environmentId !== null ? (
                            <FloatingStopAll environmentId={environmentId} />
                          ) : null}
                        </>
                      ) : null
                    }
                    onExpand={(options) => {
                      if (options?.takeOver)
                        setTakeOver((current) => new Set(current).add(session.id));
                      expand(session);
                    }}
                    onCollapse={collapse}
                    onControl={(next) => send({ sessionId: session.id, control: next })}
                    onDismiss={() => dismiss(session)}
                  />
                );
              })}
            </div>
          </aside>
        )}
      </PreviewSessionStackSurface>
    </>
  );
}
