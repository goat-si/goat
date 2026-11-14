import { ChannelTaskChip } from "@goat/contracts";
import * as Schema from "effect/Schema";

const decodeChip = Schema.decodeUnknownSync(ChannelTaskChip);

/** A task's chip in the bot's conversation, with what its worker asks of the person. */
export const taskChip = (taskId: string, needs: Partial<ChannelTaskChip> = {}) =>
  decodeChip({
    taskId,
    conversationId: "conversation",
    taskVersion: 2,
    title: taskId,
    status: "running",
    originKind: "goat",
    requesterLabel: "You",
    createdAt: "2026-11-11T02:00:00.000Z",
    updatedAt: "2026-11-11T02:00:00.000Z",
    openQuestionCount: 0,
    ...needs,
  });
