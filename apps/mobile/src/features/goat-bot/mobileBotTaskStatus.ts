import { botTaskWait, presentTaskStatus, type BotWorkTask } from "@goat/client-runtime/goatBot";
import type { ChannelTaskChip, ChannelTaskId } from "@goat/contracts";

/** The newest chip of each task in the bot's conversation. */
export type MobileTaskChips = ReadonlyMap<ChannelTaskId, ChannelTaskChip>;

export const NO_TASK_CHIPS: MobileTaskChips = new Map();

/** What a listed task says: what it waits on the person for, as the face reads it, else its status. */
export function mobileBotTaskStatus(row: BotWorkTask["row"], chips: MobileTaskChips): string {
  return (
    botTaskWait(row, chips.get(row.task.taskId)) ??
    presentTaskStatus(row.task.status, row.view.doneAt).label
  );
}
