import { expect, it } from "@effect/vitest";

import { advertisesMemoryTools } from "./remoteToolNames.ts";

it("counts memory tools a remote lists under shipped or canonical names, and nothing else", () => {
  expect(advertisesMemoryTools([{ name: "memory_search" }])).toBe(true);
  expect(advertisesMemoryTools([{ name: "goat_memory_search" }])).toBe(true);
  expect(advertisesMemoryTools([{ name: "goat_memory_settings_read" }])).toBe(true);
  expect(advertisesMemoryTools([{ name: "goat_thread_launch" }, { name: "goat_note_read" }])).toBe(
    false,
  );
});
