import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { RunId } from "./baseSchemas.ts";
import {
  OrchestrationV2CloudSourceRestriction,
  OrchestrationV2CloudTask,
  OrchestrationV2SessionCapabilities,
} from "./orchestrationV2.ts";

const decodeCapabilities = Schema.decodeUnknownSync(OrchestrationV2SessionCapabilities);
const decodeTask = Schema.decodeUnknownSync(OrchestrationV2CloudTask);
const encodeTask = Schema.encodeSync(OrchestrationV2CloudTask);
const decodeRestriction = Schema.decodeSync(OrchestrationV2CloudSourceRestriction);

describe("cloud foundation schemas", () => {
  it("decodes historical local session capabilities without requiring adapter changes", () => {
    const decoded = decodeCapabilities({
      supportsMultipleProviderThreadsPerSession: false,
      supportsModelSwitchInSession: false,
      supportsProviderSwitchingViaHandoff: false,
      supportsRuntimeModeSwitchInSession: false,
      pendingRequestsSurviveRestart: false,
    });
    expect(decoded.executionLocation).toBe("local");
    expect(decoded.sourceRestriction).toBe("published-ref");
    expect(decoded.followUp).toEqual({ supported: true });
  });
  it("accepts project-folder as a cloud source restriction", () => {
    expect(decodeRestriction("project-folder")).toBe("project-folder");
  });
  it.each([
    { accepted: false },
    { accepted: true },
    { accepted: true, localChangesIncluded: true },
    { accepted: false, localChangesIncluded: false },
  ])("round-trips task ownership and optional local source evidence (%s)", (options) => {
    const { accepted } = options;
    const task = {
      taskId: "remote-1",
      ...(accepted ? { acceptedAppRunId: RunId.make("run:accepted") } : {}),
      url: "https://example.com/tasks/1",
      title: "Fix task",
      status: "succeeded" as const,
      tracking: "polled" as const,
      progress: "Done",
      summary: "Fixed",
      prUrl: "https://github.com/acme/repo/pull/1",
      branch: "agent/fix",
      source: { repository: "https://github.com/acme/repo", branch: "dev", sha: "a".repeat(40) },
      localChangesExcluded: true,
      ...("localChangesIncluded" in options
        ? { localChangesIncluded: options.localChangesIncluded }
        : {}),
      updatedAt: "2026-10-13T00:00:00.000Z",
    };
    const encoded = encodeTask(task);
    expect(encoded).toEqual(task);
    expect(decodeTask(encoded)).toEqual(task);
    expect(Object.hasOwn(encoded, "acceptedAppRunId")).toBe(accepted);
    expect(Object.hasOwn(encoded, "localChangesIncluded")).toBe("localChangesIncluded" in options);
    expect(Object.values(encoded)).not.toContain(undefined);
    expect(() => decodeTask({ ...task, status: "completed" })).toThrow();
    expect(() => decodeTask({ ...task, tracking: "timer" })).toThrow();
    expect(() => decodeTask({ ...task, localChangesIncluded: "true" })).toThrow();
  });
  it("decodes saved failures without terminal-error evidence and round-trips it when present", () => {
    const failed = {
      taskId: "session_ABC123",
      status: "failed" as const,
      tracking: "polled" as const,
      error: "API Error: 529 Overloaded",
      source: { repository: "https://github.com/acme/repo", branch: "dev" },
      localChangesExcluded: false,
      updatedAt: "2026-10-13T00:00:00.000Z",
    };
    expect(Object.hasOwn(decodeTask(failed), "confirmedTerminalError")).toBe(false);
    const confirmed = { ...failed, confirmedTerminalError: true as const };
    expect(decodeTask(encodeTask(confirmed))).toEqual(confirmed);
    expect(() => decodeTask({ ...failed, confirmedTerminalError: false })).toThrow();
  });
});
