import { type PreviewSession, ThreadId } from "@goat/contracts";

import {
  closeServerPictureInPicture,
  openServerPictureInPicture,
  serverPictureInPictureKey,
  supportsServerPictureInPicture,
  useServerPictureInPictureKey,
} from "~/browser/serverPictureInPicture";
import { PanelRightIcon, PictureInPictureIcon, XIcon } from "~/components/solar";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { DesktopPreviewOverlay } from "~/previewStateStore";

import { previewBridge } from "../previewBridge";

function HeaderButton(props: {
  readonly label: string;
  readonly tooltip?: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={props.pressed ? "secondary" : "ghost"}
            size="icon-xs"
            aria-label={props.label}
            aria-pressed={props.pressed}
            disabled={props.disabled}
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * What the floating player offered for a browser tab, on the tab's card: open it in the thread's
 * right panel, pop it into its own window, and close the card while the agent keeps working.
 * A tab this desktop draws pops out its webview; a streamed tab pops out its stream.
 */
export function BrowserCardActions(props: {
  readonly session: PreviewSession;
  /** This desktop draws the tab in a webview, so it pops out natively, never as a stream. */
  readonly drawnHere: boolean;
  /** The drawn tab's webview id and state; null until this desktop hosts it. */
  readonly hosted: {
    readonly runtimeTabId: string;
    readonly overlay: DesktopPreviewOverlay | null;
  } | null;
  /** The streamed picture, which seeds a popped-out stream with the frame on screen. */
  readonly canvas: () => HTMLCanvasElement | null;
  readonly onOpenInPanel: (() => void) | null;
  readonly onClose: () => void;
}) {
  const { session, hosted } = props;
  const tabId = session.target.kind === "browser" ? session.target.tabId : null;
  const threadId = session.threadId;
  const serverKey = useServerPictureInPictureKey();
  const streamPoppedOut =
    tabId !== null &&
    threadId !== undefined &&
    serverKey === serverPictureInPictureKey(threadId, tabId);
  const poppedOut = hosted ? hosted.overlay?.pictureInPicture === true : streamPoppedOut;
  const canPopOut =
    tabId !== null &&
    threadId !== undefined &&
    session.status !== "stopped" &&
    (props.drawnHere
      ? hosted !== null && previewBridge !== null
      : streamPoppedOut || supportsServerPictureInPicture());

  const togglePopOut = async () => {
    if (tabId === null || threadId === undefined) return;
    try {
      if (hosted) {
        const bridge = previewBridge?.pictureInPicture;
        await (poppedOut ? bridge?.close : bridge?.open)?.(hosted.runtimeTabId);
      } else if (streamPoppedOut) {
        closeServerPictureInPicture();
      } else {
        await openServerPictureInPicture({
          environmentId: session.environmentId,
          threadId: ThreadId.make(threadId),
          tabId,
          seed: props.canvas(),
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to pop out the browser",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  return (
    <span className="flex items-center gap-0.5">
      {props.onOpenInPanel ? (
        <HeaderButton label="Open in the right panel" onClick={props.onOpenInPanel}>
          <PanelRightIcon />
        </HeaderButton>
      ) : null}
      {canPopOut ? (
        <HeaderButton
          label={poppedOut ? "Close separate window" : "Pop into separate window"}
          pressed={poppedOut}
          disabled={hosted !== null && hosted.overlay?.hasWebContents !== true}
          onClick={() => void togglePopOut()}
        >
          <PictureInPictureIcon />
        </HeaderButton>
      ) : null}
      <HeaderButton label="Close" tooltip="Close (the agent keeps working)" onClick={props.onClose}>
        <XIcon />
      </HeaderButton>
    </span>
  );
}
