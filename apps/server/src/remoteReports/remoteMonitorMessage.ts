import { CommandId, MessageId, type ThreadId } from "@goat/contracts";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * A server message to a dispatch's origin thread, queued after its active turn. The key names the
 * event once, so a crash replay is deduped by its command receipt.
 */
export const dispatchMonitorMessage = (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  input: {
    readonly key: string;
    readonly threadId: ThreadId;
    readonly text: string;
    readonly summary: string;
  },
) =>
  threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`server:${input.key}`),
    threadId: input.threadId,
    messageId: MessageId.make(`message:${input.key}`),
    text: input.text,
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
    notification: { source: { kind: "monitor" }, outcome: "updated", summary: input.summary },
    dispatchMode: { type: "queue_after_active" },
  });
