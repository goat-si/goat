import type { ThreadId } from "@goat/contracts";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { LaunchWatchWake } from "./launchWatch.ts";

/**
 * Wakes a thread with a server message queued after its active run: the path launch watches
 * use for a finished or waiting launch, and handoffs use when a person answers. The wake's ids
 * are deterministic per event, so a replayed dispatch is a receipt, not a second message.
 */
export const wakeThread = (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  threadId: ThreadId,
  message: LaunchWatchWake,
) =>
  threads.dispatch({
    type: "message.dispatch",
    commandId: message.commandId,
    threadId,
    messageId: message.messageId,
    text: message.text,
    notification: message.notification,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  });
