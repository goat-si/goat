import { ProjectId, ProviderInstanceId, ScheduledTaskId, ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import {
  CHECK_IN_PROMPT,
  checkInRoutineInput,
  findCheckInRoutine,
  type CheckInRoutineSource,
} from "./checkInPreset.ts";

const bot = { projectId: ProjectId.make("bot-project"), threadId: ThreadId.make("bot-thread") };
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

it("binds the check-in to the bot's conversation and notifies only on important updates", () => {
  const input = checkInRoutineInput({ bot, modelSelection, creationSource: "web" });
  expect(input).toMatchObject({
    title: "Check in",
    prompt: CHECK_IN_PROMPT,
    enabled: true,
    notificationPolicy: "important_updates",
    projectId: bot.projectId,
    threadId: bot.threadId,
    workspaceStrategy: { type: "root" },
    modelSelection,
    creationSource: "web",
  });
});

it("defaults to weekday mornings at nine", () => {
  const input = checkInRoutineInput({ bot, modelSelection, creationSource: "mobile" });
  expect(input.schedule).toEqual({
    type: "fixed_time",
    timeOfDay: "09:00",
    weekdays: [1, 2, 3, 4, 5],
  });
});

it("runs unattended at the lowest runtime mode so anything needing approval is refused", () => {
  const input = checkInRoutineInput({ bot, modelSelection, creationSource: "web" });
  expect(input.runtimeMode).toBe("approval-required");
  expect(input.interactionMode).toBe("default");
});

it("keeps the chosen time and stores the chosen days once each, in week order", () => {
  const input = checkInRoutineInput({
    bot,
    modelSelection,
    creationSource: "web",
    timeOfDay: "17:30",
    weekdays: [6, 0, 6, 3],
  });
  expect(input.schedule).toEqual({ type: "fixed_time", timeOfDay: "17:30", weekdays: [0, 3, 6] });
});

const task = (id: string, fields: Partial<CheckInRoutineSource> = {}): CheckInRoutineSource => ({
  id: ScheduledTaskId.make(id),
  title: "Check in",
  threadId: bot.threadId,
  ...fields,
});

it("finds the bot's check-in routine and ignores other routines and other threads", () => {
  expect(
    findCheckInRoutine(
      [
        task("other-title", { title: "Morning summary" }),
        task("other-thread", { threadId: ThreadId.make("elsewhere") }),
        task("unbound", { threadId: null }),
      ],
      bot.threadId,
    ),
  ).toBeUndefined();
  expect(
    findCheckInRoutine([task("a", { title: "Morning summary" }), task("b")], bot.threadId)?.id,
  ).toBe("b");
});
