import type { EnvironmentId } from "@goat/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  attachmentUploadBlockReason,
  type AttachmentUploadState,
} from "../../lib/attachmentUploadState";
import { toastManager } from "../ui/toast";

/** Answers and approval redirects need their uploads first; a plain send can wait for them. */
export function attachmentUploadGate(input: {
  readonly imageIds: ReadonlyArray<string>;
  readonly uploadsByImageId: Readonly<Record<string, AttachmentUploadState>>;
  readonly environmentId: EnvironmentId;
  readonly answering: boolean;
  readonly uploadsSupported: boolean;
}) {
  const blockReason = attachmentUploadBlockReason(input);
  const uploadsPending = input.uploadsSupported && blockReason !== null;
  return {
    blockReason,
    plainSend: !input.answering,
    uploadsPending,
    /** A plain send with uploads still running queues instead of sending. */
    canQueue: uploadsPending && !input.answering,
    uploadFailed: input.imageIds.some((id) => input.uploadsByImageId[id]?.status === "failed"),
  };
}

/** A send that would strand work still preparing in the draft waits for a second press. */
export function composerSendWaitNotice(state: {
  readonly compressingImage: boolean;
  readonly resolvingContext: boolean;
}): { readonly title: string; readonly description: string } | null {
  // A send while a pasted image is still compressing would leave it out of this turn's
  // snapshot, and it would surface in the next draft instead.
  if (state.compressingImage) {
    return {
      title: "Still compressing a pasted image.",
      description: "Send again once its thumbnail appears.",
    };
  }
  if (state.resolvingContext) {
    return {
      title: "Still bringing attached context into this message.",
      description: "Send again once its chip resolves.",
    };
  }
  return null;
}

/**
 * A plain send pressed while attachments upload waits for them. The composer stays locked with the
 * message until the uploads finish and it sends, or one fails and it unlocks with everything intact.
 */
export function useSendAfterUploads(
  draftKey: string,
  input: {
    readonly canQueue: boolean;
    readonly uploadsPending: boolean;
    readonly uploadFailed: boolean;
  },
) {
  const [queuedKey, setQueuedKey] = useState<string | null>(null);
  const [settled, setSettled] = useState<{ readonly send: boolean } | null>(null);
  const toastId = useRef<string | null>(null);
  const queued = queuedKey === draftKey;
  if (queued && !input.uploadsPending) {
    setQueuedKey(null);
    setSettled({ send: !input.uploadFailed });
  }
  const closeNotice = () => {
    if (toastId.current !== null) toastManager.close(toastId.current);
    toastId.current = null;
  };
  const queue = () => {
    setQueuedKey(draftKey);
    toastId.current = toastManager.add({
      type: "loading",
      title: "Sending after upload…",
      timeout: 0,
      actionProps: {
        children: "Cancel",
        onClick: () => {
          closeNotice();
          setQueuedKey(null);
        },
      },
    });
  };
  const intercept = (event: { preventDefault: () => void } | undefined, fromQueue: boolean) => {
    if (fromQueue || (!queued && !input.canQueue)) return false;
    event?.preventDefault();
    if (!queued) queue();
    return true;
  };
  return { queued, intercept, settled, closeNotice };
}

/** Runs the queued send once React has unlocked the composer. */
export function useQueuedSendDelivery(
  queue: Pick<ReturnType<typeof useSendAfterUploads>, "settled" | "closeNotice">,
  send: () => void,
) {
  const finish = useEffectEvent((shouldSend: boolean) => {
    queue.closeNotice();
    if (shouldSend) send();
  });
  const { settled } = queue;
  // oxlint-disable-next-line goat/react-effect-budget -- The queued send runs after the unlocking render commits.
  useEffect(() => {
    if (settled) finish(settled.send);
  }, [settled]);
}
