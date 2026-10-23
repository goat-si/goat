import { expect, it } from "@effect/vitest";

import { advertisesMemoryTools, remoteToolName } from "./remoteToolNames.ts";

it("counts memory tools a remote lists under shipped or canonical names, and nothing else", () => {
  expect(advertisesMemoryTools([{ name: "memory_search" }])).toBe(true);
  expect(advertisesMemoryTools([{ name: "goat_memory_search" }])).toBe(true);
  expect(advertisesMemoryTools([{ name: "goat_memory_settings_read" }])).toBe(true);
  expect(advertisesMemoryTools([{ name: "goat_thread_launch" }, { name: "goat_note_read" }])).toBe(
    false,
  );
});

it("sends shipped names to a remote that predates the flip or whose version is unreadable", () => {
  for (const version of [undefined, "0.1.2", "0.1.2-nightly.20261024", "0.0.9", "test", ""]) {
    expect(remoteToolName("goat_task_read", version), String(version)).toBe("task_status");
    expect(remoteToolName("task_status", version), String(version)).toBe("task_status");
    expect(remoteToolName("goat_decision_read", version), String(version)).toBe(
      "goat_decision_get",
    );
    expect(remoteToolName("goat_thread_send", version), String(version)).toBe("goat_thread_send");
  }
});

it("sends canonical names to a remote that answers to them", () => {
  for (const version of ["0.1.3", "0.2.0-nightly.1", "1.0.0"]) {
    expect(remoteToolName("task_status", version), version).toBe("goat_task_read");
    expect(remoteToolName("goat_decision_get", version), version).toBe("goat_decision_read");
    expect(remoteToolName("goat_call", version), version).toBe("goat_call");
  }
  expect(remoteToolName("not_a_registry_tool", "1.0.0")).toBe("not_a_registry_tool");
});
