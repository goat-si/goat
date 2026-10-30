import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2Items } from "./threadListV2";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";

const makeThread = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
  makeThreadShellFixture({ environmentId, id: ThreadId.make(id), title: id, ...overrides });

const running = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: NOW,
};

describe("threadListV2 Priority", () => {
  it("keeps a thread listed when it starts running, with the default collapsed Working shelf", () => {
    const listedIds = (threads: EnvironmentThreadShell[]) =>
      buildThreadListV2Items({
        threads,
        environmentId: null,
        searchQuery: "",
        now: NOW,
        workingShelfEnabled: true,
        workingShelfExpanded: false,
      }).items.map((item) => String(item.thread.id));

    expect(listedIds([makeThread("other"), makeThread("task")])).toContain("task");
    expect(listedIds([makeThread("other"), makeThread("task", { runtime: running })])).toContain(
      "task",
    );
  });
});
