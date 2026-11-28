import type { RefObject } from "react";
import type { PreviewAnnotationPayload } from "@goat/contracts";
import type { ComposerDispatchMode } from "@goat/client-runtime/state/composer-dispatch";
import type { ComposerSubmissionIntent } from "../../composer-logic";
import type { ComposerImageAttachment, DraftId } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { readPendingWorkspaceDefault } from "../../lib/draftWorkspaceDefaults";

type Send = (
  event?: { preventDefault: () => void },
  mode?: ComposerDispatchMode,
  intent?: ComposerSubmissionIntent,
  annotation?: { annotation: PreviewAnnotationPayload; image: ComposerImageAttachment | null },
) => Promise<void>;
export function useSendWithRouting(
  onSend: Send,
  sendInFlightRef: RefObject<boolean>,
  readPendingEnvironmentChange: () => unknown,
  refreshBeforeSend: () => Promise<boolean> | null,
  draftId: DraftId | null = null,
) {
  const onSendLatest = useStableCallback(onSend);
  const sendWithEnvironmentRefresh = async (...args: Parameters<Send>) => {
    args[0]?.preventDefault();
    const refresh =
      args[3] || sendInFlightRef.current || readPendingEnvironmentChange() !== null
        ? null
        : refreshBeforeSend();
    if (refresh === null) return onSend(...args);
    sendInFlightRef.current = true;
    const ready = await refresh.finally(() => {
      sendInFlightRef.current = false;
    });
    if (ready) return onSendLatest(...args);
  };
  const sendWithEnvironmentRefreshLatest = useStableCallback(sendWithEnvironmentRefresh);
  return async (...args: Parameters<Send>) => {
    args[0]?.preventDefault();
    const workspaceDefault =
      draftId && !sendInFlightRef.current ? readPendingWorkspaceDefault(draftId) : null;
    if (workspaceDefault === null) return sendWithEnvironmentRefresh(...args);
    sendInFlightRef.current = true;
    await workspaceDefault.finally(() => {
      sendInFlightRef.current = false;
    });
    return sendWithEnvironmentRefreshLatest(...args);
  };
}
