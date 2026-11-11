import { expect, it, vi } from "vite-plus/test";

import { goatBotModelPillMenu } from "./goatBotModelPillMenu";

const main = {
  label: "gpt-6-luna",
  accessibilityLabel: "GOAT Bot model: gpt-6-luna",
  items: [],
  disabled: false,
  select: vi.fn(),
};

it("never offers the main bot's model in a member's chat whose own model is not known yet", () => {
  // A member on a server whose config has not loaded has no menu of its own; choosing from the
  // main bot's menu there would change the main bot's model.
  expect(goatBotModelPillMenu(null, main, true)).toBeNull();
  expect(goatBotModelPillMenu(null, main, false)).toMatchObject({
    label: "gpt-6-luna",
    opens: true,
  });
});
