import { describe, expect, it } from "@effect/vitest";
import { resolveScopedNewThreadProjectRef } from "./scopedNewThread";

describe("resolveScopedNewThreadProjectRef", () => {
  const local = { environmentId: "env-local", projectId: "api" };
  const remote = { environmentId: "env-remote", projectId: "api-remote" };
  const api = { environmentId: "env-local", id: "api", memberProjectRefs: [local, remote] };
  const web = {
    environmentId: "env-local",
    id: "web",
    memberProjectRefs: [{ environmentId: "env-local", projectId: "web" }],
  };
  const viewedWeb = { environmentId: "env-local", projectId: "web" };

  it("starts in the one scoped project even while another project's thread is open", () => {
    expect(
      resolveScopedNewThreadProjectRef({
        shiftKey: false,
        scopedProjectGroups: [api],
        viewed: viewedWeb,
      }),
    ).toBe(local);
    expect(
      resolveScopedNewThreadProjectRef({
        shiftKey: false,
        scopedProjectGroups: [api],
        viewed: null,
      }),
    ).toBe(local);
  });

  it("keeps the viewed thread's environment when that thread is in the scoped project", () => {
    expect(
      resolveScopedNewThreadProjectRef({
        shiftKey: false,
        scopedProjectGroups: [api],
        viewed: { environmentId: "env-remote", projectId: "api-remote" },
      }),
    ).toBe(remote);
  });

  it("leaves Shift+click, no scope and several scoped projects to the existing rule", () => {
    expect(
      resolveScopedNewThreadProjectRef({
        shiftKey: true,
        scopedProjectGroups: [api],
        viewed: viewedWeb,
      }),
    ).toBeNull();
    expect(
      resolveScopedNewThreadProjectRef({
        shiftKey: false,
        scopedProjectGroups: [],
        viewed: viewedWeb,
      }),
    ).toBeNull();
    expect(
      resolveScopedNewThreadProjectRef({
        shiftKey: false,
        scopedProjectGroups: [api, web],
        viewed: viewedWeb,
      }),
    ).toBeNull();
  });
});
