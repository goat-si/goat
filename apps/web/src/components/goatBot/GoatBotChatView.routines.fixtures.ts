import type { BotRoutineSource } from "@goat/client-runtime/scheduledTasks";
import { ChannelInputId, CommandId, ScheduledTaskId, ThreadId } from "@goat/contracts";

const threadId = ThreadId.make("bot");
const local = (hour: number, minute = 0) => new Date(2026, 10, 14, hour, minute).toISOString();

/** A routine in the bot's chat whose last run answered input in-1 and the one before was quiet. */
export const routine: BotRoutineSource = {
  id: ScheduledTaskId.make("routine:morning"),
  title: "Morning check",
  prompt: "Look over my work",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
  threadId,
  nextRunAt: null,
  lastRunAt: local(9),
  lastRunStatus: "succeeded",
  lastRunError: null,
  recentRuns: [
    {
      firingId: CommandId.make("firing-9"),
      status: "completed",
      requestedAt: local(9),
      completedAt: local(9, 5),
      conversation: { threadId, inputId: ChannelInputId.make("in-1") },
    },
    {
      firingId: CommandId.make("firing-8"),
      status: "completed",
      requestedAt: local(8),
      completedAt: local(8, 2),
      quiet: true,
      conversation: { threadId, inputId: ChannelInputId.make("in-0") },
    },
  ],
};
