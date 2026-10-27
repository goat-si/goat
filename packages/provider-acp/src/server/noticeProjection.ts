import type * as AcpSchema from "effect-acp/compat";
import { sessionUpdateIsReplay, type AcpParsedSessionEvent } from "./runtimeModel.ts";

export function isReplayedAcpNotice(notification: AcpSchema.SessionNotification): boolean {
  const update = notification.update;
  return (
    sessionUpdateIsReplay(notification) &&
    (update.sessionUpdate === "notice" ||
      (update.sessionUpdate === "_t3_unknown" && update.originalSessionUpdate === "notice"))
  );
}

export function acpNoticeContent(
  notice: Extract<AcpParsedSessionEvent, { readonly _tag: "NoticeReceived" }>,
) {
  return {
    title: notice.title,
    message:
      notice.description === undefined ? notice.title : `${notice.title}\n\n${notice.description}`,
    // Preserve the clients' warning treatment for severities outside the GOAT contract.
    severity: notice.severity === "info" ? ("info" as const) : ("warning" as const),
  };
}
