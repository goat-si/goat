import { scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentId, PreviewSessionControl, ScopedThreadRef } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";

import { Button } from "~/components/ui/button";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { previewMiniPlayerSourceKey } from "~/previewMiniPlayerStore";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { previewSessionsEnvironment } from "~/state/previewSessions";
import { useAtomCommand } from "~/state/use-atom-command";

import { AgentScreenCard } from "./AgentScreenCard";
import { PreviewSessionStackSurface } from "./PreviewSessionStackSurface";
import { selectAgentCardsShown, usePreviewSessionStack } from "./previewSessionStackStore";
import {
  AGENT_CARD_WIDTH_PX,
  useAgentCardsPlacement,
  useAgentScreenSessions,
} from "./useAgentScreenCards";

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
 * What agents drive on this environment's host, one card per browser tab or desktop session,
 * waiting ones first, at the thread pane's top right where the floating mini player starts. The
 * cards hide when the pane has no room beside the conversation, and the header's toggle shows or
 * hides them. Thumbnails stream only while cards show and the window is visible (D11, #1215).
 */
export function PreviewSessionStack(props: {
  readonly environmentId: EnvironmentId | null;
  /** The thread on screen; its mini player already shows one of its tabs. */
  readonly threadRef: ScopedThreadRef | null;
}) {
  // An open right panel is the expanded view; the cards step aside until it closes.
  const panelOpen = useRightPanelStore((state) =>
    props.threadRef ? selectActiveRightPanel(state.byThreadKey, props.threadRef) !== null : false,
  );
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    props.threadRef ? selectThreadPreviewMiniPlayer(state.byThreadKey, props.threadRef) : null,
  );
  const sessions = useAgentScreenSessions(props.environmentId, props.threadRef);
  const control = useAtomCommand(previewSessionsEnvironment.control);
  const shown = usePreviewSessionStack(selectAgentCardsShown);
  const dismiss = usePreviewSessionStack((state) => state.dismiss);
  const focus = usePreviewSessionStack((state) => state.focus);
  const focusRequest = usePreviewSessionStack((state) => state.focusRequest);
  const probe = useRef<HTMLDivElement>(null);
  const placement = useAgentCardsPlacement(
    probe,
    [
      props.threadRef ? scopedThreadKey(props.threadRef) : "",
      miniPlayer ? previewMiniPlayerSourceKey(miniPlayer.source) : "",
      panelOpen,
    ].join("|"),
  );
  const focusedId =
    focus === null
      ? null
      : (sessions.find((session) =>
          focus.sessionId === undefined
            ? session.kind === focus.kind
            : session.id === focus.sessionId,
        )?.id ?? null);
  const stoppable = sessions.filter((session) =>
    session.capabilities.controls.includes("stop"),
  ).length;

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
        dockedHidden={panelOpen || !shown || placement === null}
      >
        {({ floating, live, maxHeight, toggle, captureNotice }) => (
          <aside
            className={
              floating
                ? "pointer-events-none flex flex-col gap-2"
                : "pointer-events-none fixed z-40 flex flex-col gap-2"
            }
            style={
              floating || placement === null
                ? { width: AGENT_CARD_WIDTH_PX, maxHeight }
                : {
                    width: AGENT_CARD_WIDTH_PX,
                    top: placement.top,
                    right: placement.right,
                    maxHeight: placement.maxHeight,
                  }
            }
            aria-label="Agents on screen"
          >
            {captureNotice ? (
              <p
                data-stack-interactive
                className="pointer-events-auto rounded-2xl border bg-popover p-2 text-xs text-muted-foreground"
              >
                {captureNotice}
              </p>
            ) : null}
            <div className="pointer-events-none flex min-h-0 flex-col gap-2 overflow-y-auto">
              {sessions.map((session, index) => (
                <AgentScreenCard
                  key={session.id}
                  focused={session.id === focusedId}
                  focusRequest={focusRequest}
                  session={session}
                  live={live}
                  headerAction={index === 0 ? toggle : null}
                  onControl={(next) => send({ sessionId: session.id, control: next })}
                  onDismiss={() => dismiss(session.id)}
                />
              ))}
            </div>
            {stoppable > 1 && environmentId !== null ? (
              <div data-stack-interactive className="pointer-events-auto flex justify-end">
                <StopAllButton
                  environmentId={environmentId}
                  onStop={() => send({ control: "stopAll" })}
                />
              </div>
            ) : null}
          </aside>
        )}
      </PreviewSessionStackSurface>
    </>
  );
}
