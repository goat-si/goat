import { toastManager } from "../ui/toast";
import type { ChangeRequestTerminology } from "@goat/client-runtime/source-control-clients";

export function offHeadPullRequestCheckoutToast(terminology: ChangeRequestTerminology) {
  return {
    type: "warning",
    title: "Checked out, but not confirmed on the latest commit",
    description: `This checkout could not be confirmed at the ${terminology.singular}'s latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.`,
  } as const;
}

export function reportCheckoutCommandError(error: Error) {
  toastManager.add({
    type: "error",
    title: "Could not copy checkout command",
    description: error.message,
  });
}
