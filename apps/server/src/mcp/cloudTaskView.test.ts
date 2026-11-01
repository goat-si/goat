import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestratorMcpCloudTask, RunId, type OrchestrationV2CloudTask } from "@goat/contracts";
import { cloudTaskView } from "./cloudTaskView.ts";

const decodeTask = Schema.decodeUnknownSync(OrchestratorMcpCloudTask);
const encodeTask = Schema.encodeSync(OrchestratorMcpCloudTask);

const task: OrchestrationV2CloudTask = {
  taskId: "accepted-task",
  acceptedAppRunId: RunId.make("run:accepted"),
  status: "running",
  tracking: "polled",
  url: "https://example.com/session/1",
  prUrl: "https://github.com/acme/repo/pull/2",
  branch: "agent/fix",
  summary: "Delivered result",
  error: "Observation error",
  source: { repository: "https://github.com/acme/repo", branch: "dev" },
  localChangesExcluded: true,
  updatedAt: "2026-10-13T00:00:00.000Z",
};
describe("cloud MCP task output", () => {
  it("keeps task state separate from GOAT run state and round-trips result links", () => {
    const view = cloudTaskView(task)!;
    expect(decodeTask(encodeTask(view))).toEqual(view);
    expect(view.status).toBe("running");
    expect(view.tracking).toBe("polled");
    expect(view.prUrl).toBe(task.prUrl);
    expect(view.localChangesExcluded).toBe(true);
    expect(Object.hasOwn(view, "acceptedAppRunId")).toBe(false);
    expect(Object.hasOwn(view, "localChangesIncluded")).toBe(false);
    expect(Object.values(view)).not.toContain(undefined);
    expect(cloudTaskView(undefined)).toBeUndefined();
  });
  it.each([true, false])("preserves optional local source inclusion evidence (%s)", (included) => {
    const view = cloudTaskView({ ...task, localChangesIncluded: included })!;
    expect(view.localChangesIncluded).toBe(included);
    expect(decodeTask(encodeTask(view))).toEqual(view);
    expect(Object.values(view)).not.toContain(undefined);
  });
  it("bounds output without turning an unsafe or oversized URL into a link", () => {
    const view = cloudTaskView({
      ...task,
      summary: "s".repeat(5000),
      error: "e".repeat(2000),
      branch: "b".repeat(1000),
      url: "https://user:secret@example.com/session",
      prUrl: `https://example.com/${"x".repeat(3000)}`,
    })!;
    expect(view.summary).toHaveLength(4000);
    expect(view.error).toHaveLength(1000);
    expect(view.branch).toHaveLength(512);
    expect(view.url).toBeUndefined();
    expect(view.prUrl).toBeUndefined();
    expect(Object.hasOwn(view, "url")).toBe(false);
    expect(Object.hasOwn(view, "prUrl")).toBe(false);
    expect(Object.values(view)).not.toContain(undefined);
    expect(cloudTaskView({ ...task, url: "javascript:alert(1)" })!.url).toBeUndefined();
    expect(() => decodeTask({ ...view, status: "working" })).toThrow();
  });
});
