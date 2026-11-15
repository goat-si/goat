import "./useMobileGoatBotSession.testHarness";
import type { BotProfile } from "@goat/contracts";
import { EnvironmentId } from "@goat/contracts";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import {
  bot,
  environment,
  harness,
  render,
  setupSession,
  unmountSession,
  view,
} from "./useMobileGoatBotSession.testHarness";
import { conversation } from "./useMobileGoatBotSession.fixtures";
import * as botSessions from "./useMobileGoatBotSession";

beforeEach(setupSession);
afterEach(unmountSession);

const hasTaskCard = () => view.session.rows.some((row) => row.kind === "task");

it("a task card the work list opens stays out of the chat while the computer is offline, for that computer and bot only (#3322)", async () => {
  const a = EnvironmentId.make("env");
  const b = EnvironmentId.make("env-b");
  harness.supportsTaskThreads = true;
  harness.items = conversation({ environmentId: "env", threadId: "worker-1" });
  harness.botRef = bot(a);
  harness.environments = [environment("env"), environment("env-b")];
  harness.lists = { "env/main": ["task-1"] };
  await render();
  expect(hasTaskCard()).toBe(false);
  // Offline: the list is not read, and the last answer for this computer and bot still applies.
  harness.environments = [environment("env", false), environment("env-b", false)];
  await render();
  expect(hasTaskCard()).toBe(false);
  // Another bot on the same computer, then another computer: A's main list does not apply.
  view.member = {
    botId: "scout",
    role: "member",
    name: "Scout",
    environmentId: a,
    sessionThreadId: "thread-scout",
    state: "active",
  } as unknown as BotProfile;
  await render();
  expect(hasTaskCard()).toBe(true);
  view.member = null;
  harness.botRef = bot(b);
  await render();
  expect(hasTaskCard()).toBe(true);
  harness.botRef = bot(a);
  await render();
  expect(hasTaskCard()).toBe(false);
  // Back online, a fresh answer replaces the kept one, an empty answer included.
  harness.environments = [environment("env"), environment("env-b")];
  await render();
  expect(hasTaskCard()).toBe(false);
  harness.lists = { "env/main": [] };
  await render();
  expect(hasTaskCard()).toBe(true);
  harness.environments = [environment("env", false), environment("env-b", false)];
  await render();
  expect(hasTaskCard()).toBe(true);
  await botSessions.disposeMobileGoatBotEnvironment(a);
  await botSessions.disposeMobileGoatBotEnvironment(b);
});

it("a task's own screen shows its card offline as it does online", async () => {
  const a = EnvironmentId.make("env");
  harness.supportsTaskThreads = true;
  harness.items = conversation({ environmentId: "env", threadId: "worker-1" });
  harness.botRef = bot(a);
  harness.environments = [environment("env")];
  harness.lists = { "env/main": ["task-1"] };
  view.taskId = "task-1" as never;
  await render();
  expect(hasTaskCard()).toBe(true);
  harness.environments = [environment("env", false)];
  await render();
  expect(hasTaskCard()).toBe(true);
  await botSessions.disposeMobileGoatBotEnvironment(a);
});
