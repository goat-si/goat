import * as Dialog from "../../components/ui/Dialog";
import {
  declinePendingApprovals,
  sendApprovalFeedback,
} from "@goat/client-runtime/state/thread-requests";

import type { ThreadDetailScreenProps } from "./ThreadDetailScreenProps";

type Approval = ThreadDetailScreenProps["activePendingApprovals"][number];

/** The screen's step before a message redirects its pending approvals (moved from ThreadDetailScreen). */
export function redirectDecline(
  props: Pick<
    ThreadDetailScreenProps,
    "activePendingUserInput" | "respondingApprovalId" | "onRespondToApproval"
  >,
  scope: AbortSignal,
  approvalsToDecline: ReadonlyArray<Approval>,
  stillSendable: (() => boolean) | undefined,
  currentPendingApprovals: () => ReadonlyArray<Approval>,
) {
  return approvalsToDecline.length > 0 && props.activePendingUserInput === null
    ? async (text: string, hasAttachmentsOrContext: boolean, saveMode = async () => true) => {
        if (scope.aborted || stillSendable?.() === false || props.respondingApprovalId !== null)
          return false;
        const feedbackTarget = approvalsToDecline[0];
        if (feedbackTarget?.supportsFeedback) {
          if (hasAttachmentsOrContext) {
            Dialog.alert(
              "Approval feedback",
              "Send approval feedback without attachments or added context.",
            );
            return false;
          }
          return (await sendApprovalFeedback(feedbackTarget, text, props.onRespondToApproval))
            ? ("responded" as const)
            : false;
        }
        return (
          (await saveMode()) &&
          // The save is a round trip: the thread may have been left or the draft edited meanwhile.
          !scope.aborted &&
          stillSendable?.() !== false &&
          (await declinePendingApprovals(approvalsToDecline, props.onRespondToApproval)) &&
          !scope.aborted &&
          // A draft edited or pasted into during the decline isn't what the user sent.
          stillSendable?.() !== false &&
          // An approval that arrived during the decline would block the redirect; the draft
          // stays so the next send declines it too.
          !currentPendingApprovals().some(
            (approval) =>
              !approvalsToDecline.some((declined) => declined.requestId === approval.requestId),
          )
        );
      }
    : undefined;
}
