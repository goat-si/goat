import type { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/uuid", () => ({ uuidv4: () => "request-1" }));
import { forgetNewBotEnvironment, newBotSlot, startNewBot } from "./mobileNewBots";

it("forgets a create when its environment leaves the app, so its answer opens nothing", async () => {
  const removed = "env-removed" as EnvironmentId;
  const kept = "env-kept" as EnvironmentId;
  const removedAnswer = Promise.withResolvers<object>();
  const keptAnswer = Promise.withResolvers<object>();
  const openRemoved = vi.fn();
  const keptOpened = Promise.withResolvers<void>();
  startNewBot(removed, [], () => removedAnswer.promise as never, openRemoved);
  startNewBot(
    kept,
    [],
    () => keptAnswer.promise as never,
    () => keptOpened.resolve(),
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
