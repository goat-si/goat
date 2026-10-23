import { expect, it } from "vite-plus/test";

import { VISIBLE_TEXT_RULES } from "./rules-visible.ts";
import { applyTextRules } from "./engine.ts";

it("loads visible rules directly without initializing rules.ts first", () => {
  expect(applyTextRules("apps/web/src/copy.ts", "T3 Code", VISIBLE_TEXT_RULES).text).toBe("GOAT");
});
