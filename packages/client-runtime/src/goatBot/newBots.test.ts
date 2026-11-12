import type { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  forgetNewBotEnvironment,
  newBotSlot,
  replaceCreatedBot,
  startNewBot,
  subscribeNewBots,
} from "./newBots.ts";

it("forgets a create when its environment leaves the app, so its answer opens nothing", async () => {
  const removed = "env-removed" as EnvironmentId;
  const kept = "env-kept" as EnvironmentId;
  const removedAnswer = Promise.withResolvers<object>();
  const keptAnswer = Promise.withResolvers<object>();
  const openRemoved = vi.fn();
  const keptOpened = Promise.withResolvers<void>();
  startNewBot(
    removed,
    [],
    () => removedAnswer.promise as never,
    openRemoved,
    {},
    () => "request-1",
  );
  startNewBot(
    kept,
    [],
    () => keptAnswer.promise as never,
    () => keptOpened.resolve(),
    {},
    () => "request-1",
  );
  forgetNewBotEnvironment(removed);
  expect(newBotSlot(removed).operation).toBeNull();
  // Both answers take the same path; the kept one, answered second, opening means the first is done.
  removedAnswer.resolve({ botId: "gone", name: "New bot", state: "active" });
  keptAnswer.resolve({ botId: "here", name: "New bot", state: "active" });
  await keptOpened.promise;
  expect(openRemoved).not.toHaveBeenCalled();
  expect(newBotSlot(removed).created).toEqual([]);
  expect(newBotSlot(kept).created.map((bot) => bot.botId)).toEqual(["here"]);
});

it("a rename of a created bot the list does not hold yet replaces its created entry; other bots are left alone", async () => {
  const environmentId = "env-renamed" as EnvironmentId;
  forgetNewBotEnvironment(environmentId);
  const opened = Promise.withResolvers<void>();
  const made = { botId: "made", name: "New bot", state: "active" };
  startNewBot(
    environmentId,
    [],
    async () => made as never,
    () => opened.resolve(),
    {},
    () => "request-1",
  );
  await opened.promise;
  const changed = vi.fn();
  using _subscription = { [Symbol.dispose]: subscribeNewBots(changed) };
  replaceCreatedBot(environmentId, { ...made, name: "Scout" } as never);
  expect(newBotSlot(environmentId).created).toEqual([{ ...made, name: "Scout" }]);
  expect(changed).toHaveBeenCalledOnce();
  // A bot this client did not just create, or another environment's, changes nothing.
  replaceCreatedBot(environmentId, { botId: "other", name: "Ada", state: "active" } as never);
  replaceCreatedBot("env-other" as EnvironmentId, { ...made, name: "Atlas" } as never);
  expect(newBotSlot(environmentId).created).toEqual([{ ...made, name: "Scout" }]);
  expect(newBotSlot("env-other" as EnvironmentId).created).toEqual([]);
  expect(changed).toHaveBeenCalledOnce();
});
