import { expect, it } from "vite-plus/test";

import { generatedBotName, isGeneratedBotName } from "./goatBotNames.ts";

it("names a new bot after the first generated name no member uses, hidden and deleted included", () => {
  expect(generatedBotName([])).toBe("New bot");
  expect(generatedBotName([{ name: "New bot" }, { name: "New bot 2" }])).toBe("New bot 3");
  expect(generatedBotName([{ name: "New bot" }, { name: "New bot 3" }])).toBe("New bot 2");
});

it("recognises exactly the names it gives, so a bot named otherwise never asks for a name", () => {
  for (const name of ["New bot", "New bot 2", "New bot 10", "New bot 123"])
    expect(isGeneratedBotName(name)).toBe(true);
  for (const name of [
    "New bot 1",
    "New bot 0",
    "New bot 02",
    "New bots",
    "new bot",
    "Ada",
    "New bot 2 ",
  ])
    expect(isGeneratedBotName(name)).toBe(false);
});
