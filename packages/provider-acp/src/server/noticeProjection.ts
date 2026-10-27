import type * as AcpSchema from "effect-acp/compat";
import { sessionUpdateIsReplay } from "./runtimeModel.ts";

export function isReplayedAcpNotice(notification: AcpSchema.SessionNotification): boolean {
  const update = notification.update;
  return (
    sessionUpdateIsReplay(notification) &&
    (update.sessionUpdate === "notice" ||
      (update.sessionUpdate === "_t3_unknown" && update.originalSessionUpdate === "notice"))
  );
}
