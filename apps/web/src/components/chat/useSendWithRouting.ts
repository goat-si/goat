import type { RefObject } from "react";
import type { PreviewAnnotationPayload } from "@goat/contracts";
import type { ComposerDispatchMode } from "@goat/client-runtime/state/composer-dispatch";
import type { ComposerSubmissionIntent } from "../../composer-logic";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";

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
) {
  const onSendLatest = useStableCallback(onSend);
  return async (...args: Parameters<Send>) => {
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
}
