import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type MemoryOwnerSourceReadPolicyView } from "@goat/contracts";
import {
  validateMemoryDestination,
  toggleMemoryRequester,
  memoryScopeForSelection,
} from "./SettingsMemoryRouteScreen.logic";
const owner = EnvironmentId.make("selected-owner");
const active = EnvironmentId.make("active-requester");
const pending = EnvironmentId.make("pending-requester");
describe("native memory destinations and owner edits", () => {
  it("rejects malformed or incomplete explicit links without substituting a destination", () => {
    expect(validateMemoryDestination(undefined)).toBe(true);
    expect(validateMemoryDestination({ environmentId: owner })).toBe(true);
    expect(validateMemoryDestination({ environmentId: owner, memorySpaceId: "bad" as never })).toBe(
      false,
    );
    expect(
      validateMemoryDestination({ memorySpaceId: "00000000-0000-4000-8000-000000000001" as never }),
    ).toBe(false);
    expect(
      validateMemoryDestination({
        environmentId: owner,
        project: { environmentId: active, projectId: "project" as never },
      }),
    ).toBe(false);
  });
  it("preserves unrelated pending enrollments and allows cancelling a pending re-enrollment", () => {
    const view = {
      policy: {
        allowedRequesterEnvironmentIds: [active],
        enrollments: [{ state: "pending", requesterEnvironmentId: pending }],
      },
    } as unknown as MemoryOwnerSourceReadPolicyView;
    expect(toggleMemoryRequester(view, active)).toEqual([pending]);
    expect(toggleMemoryRequester(view, pending)).toEqual([active]);
    expect(toggleMemoryRequester(view, owner)).toEqual([active, pending, owner]);
  });
  it("requires actual project/thread context instead of inventing a scope", () => {
    expect(memoryScopeForSelection("project", { environmentId: owner }, null)).toBeUndefined();
    expect(memoryScopeForSelection("thread", { environmentId: owner }, null)).toBeUndefined();
    expect(memoryScopeForSelection("user", { environmentId: owner }, null)).toEqual({
      kind: "user",
    });
  });
});

it("keeps explicit project and thread scopes and supports returning to user scope", () => {
  const params = {
    environmentId: owner,
    project: { environmentId: owner, projectId: "synthetic-project" as never },
    thread: { environmentId: owner, threadId: "synthetic-thread" as never },
  };
  const projectKey = { kind: "explicit" as const, sharedProjectId: "synthetic-shared-project" };
  expect(memoryScopeForSelection("project", params, projectKey)).toEqual({
    kind: "project",
    projectKey,
  });
  expect(memoryScopeForSelection("thread", params, projectKey)).toEqual({
    kind: "thread",
    thread: params.thread,
    projectKey,
  });
  expect(memoryScopeForSelection("user", params, projectKey)).toEqual({ kind: "user" });
});
