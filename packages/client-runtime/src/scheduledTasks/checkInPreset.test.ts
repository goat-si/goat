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

it("asks only about GOAT Bot tasks, which is what the bot can read for a routine", () => {
  expect(CHECK_IN_PROMPT).toContain("GOAT Bot tasks");
  expect(CHECK_IN_PROMPT).not.toContain("threads waiting");
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

it("gives each bot's check-in one fixed id, so a second save cannot create a duplicate", () => {
  const first = checkInRoutineInput({ bot, modelSelection, creationSource: "web" });
  const again = checkInRoutineInput({ bot, modelSelection, creationSource: "mobile" });
  const other = checkInRoutineInput({
    bot: { ...bot, threadId: ThreadId.make("member-thread") },
    modelSelection,
    creationSource: "web",
  });
  expect(first.id).toBeDefined();
  expect(again.id).toBe(first.id);
  expect(other.id).not.toBe(first.id);
});

it("finds the check-in by its id even after a rename, and ignores look-alike routines", () => {
  const id = checkInRoutineInput({ bot, modelSelection, creationSource: "web" }).id ?? "";
  expect(
    findCheckInRoutine([task("look-alike"), task("unbound", { threadId: null })], bot.threadId),
  ).toBeUndefined();
  expect(
    findCheckInRoutine([task("look-alike"), task(id, { title: "Morning look" })], bot.threadId)?.id,
  ).toBe(id);
});
