import { THREAD_STATUS_TEXT } from "@goat/client-runtime/state/thread-activity-announcement";
import { t } from "gt-react";

/** The thread status the window title leads with, in the person's language. */
export function translateWindowTitleStatus(status: string | null): string | null {
  switch (status) {
    case THREAD_STATUS_TEXT.approval:
      return t("Needs approval");
    case THREAD_STATUS_TEXT.input:
      return t("Needs your input");
    case THREAD_STATUS_TEXT.working:
      return t("Working");
    default:
      return status;
  }
}
