import { useLayoutEffect, useRef } from "react";
import type { ComposerSendInput } from "./useComposerSend.input";

export function usePendingApprovalRefs(
  pendingApprovals: ComposerSendInput["pendingApprovals"],
  respondingRequestIds: ComposerSendInput["respondingRequestIds"],
) {
  const pendingApprovalsRef = useRef(pendingApprovals);
  const respondingRequestIdsRef = useRef(respondingRequestIds);
  // oxlint-disable-next-line goat/react-effect-budget -- A send reads the latest approval state after uploads.
  useLayoutEffect(() => {
    pendingApprovalsRef.current = pendingApprovals;
    respondingRequestIdsRef.current = respondingRequestIds;
  }, [pendingApprovals, respondingRequestIds]);
  return { pendingApprovalsRef, respondingRequestIdsRef };
}
