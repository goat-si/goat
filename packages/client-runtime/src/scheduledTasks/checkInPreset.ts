import type {
  ModelSelection,
  OrchestrationV2CreationSource,
  ProjectId,
  ScheduledTask,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@goat/contracts";

const CHECK_IN_TITLE = "Check in";

export const CHECK_IN_PROMPT =
  "Look over my open work: GOAT Bot tasks, threads waiting on me, failed or stuck work, and anything due today. If something needs me, tell me in one short message with links. If nothing needs me, report no update.";

export const CHECK_IN_DEFAULT_TIME = "09:00";

/** Monday to Friday; 0 is Sunday. */
export const CHECK_IN_DEFAULT_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

export type CheckInRoutineSource = Pick<ScheduledTask, "id" | "title" | "threadId">;

/** A one-tap routine in the bot's own conversation that speaks up only when the person is needed. */
export function checkInRoutineInput(input: {
  readonly bot: { readonly projectId: ProjectId; readonly threadId: ThreadId };
  readonly modelSelection: ModelSelection;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly timeOfDay?: string;
  readonly weekdays?: readonly number[];
}): ScheduledTaskUpsertInput {
  return {
    title: CHECK_IN_TITLE,
    prompt: CHECK_IN_PROMPT,
    enabled: true,
    notificationPolicy: "important_updates",
    schedule: {
      type: "fixed_time",
      timeOfDay: input.timeOfDay ?? CHECK_IN_DEFAULT_TIME,
      weekdays: [...new Set(input.weekdays ?? CHECK_IN_DEFAULT_WEEKDAYS)].sort((a, b) => a - b),
    },
    projectId: input.bot.projectId,
    threadId: input.bot.threadId,
    workspaceStrategy: { type: "root" },
    modelSelection: input.modelSelection,
    // Nobody is watching a routine run, so anything that would need approval is refused.
    runtimeMode: "approval-required",
    interactionMode: "default",
    creationSource: input.creationSource,
  };
}

/** The bot's check-in routine, if the person already has one. */
export function findCheckInRoutine<Task extends CheckInRoutineSource>(
  tasks: readonly Task[],
  botThreadId: ThreadId,
): Task | undefined {
  return tasks.find((task) => task.threadId === botThreadId && task.title === CHECK_IN_TITLE);
}
