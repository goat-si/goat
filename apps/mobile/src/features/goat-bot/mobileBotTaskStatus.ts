import {
  botTaskWait,
  goatBotTaskWait,
  presentTaskStatus,
  type BotWorkTask,
} from "@goat/client-runtime/goatBot";
import type { ChannelTask, ChannelTaskChip, ChannelTaskId } from "@goat/contracts";

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

/** The same for a task known only by its summary, with no view state to say it was marked done. */
export function mobileTaskSummaryStatus(
  task: Pick<ChannelTask, "taskId" | "status">,
  chips: MobileTaskChips,
): string {
  const chip = chips.get(task.taskId);
  return (
    goatBotTaskWait({
      status: task.status,
      openQuestionCount: chip?.openQuestionCount ?? 0,
      observed: chip?.observed,
    }) ?? presentTaskStatus(task.status).label
  );
}
