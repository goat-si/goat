import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { planProjectRemoval } from "@goat/client-runtime/state/projects";

describe("project removal confirmation", () => {
  const local = {
    id: ProjectId.make("shared-id"),
    environmentId: EnvironmentId.make("local"),
    title: "Repo",
    workspaceRoot: "/work/repo",
    environmentLabel: "Local",
  };
  const remote = {
    ...local,
    environmentId: EnvironmentId.make("remote"),
    environmentLabel: "Remote",
  };

  const parent = ThreadId.make("parent");
  const listed = {
    rootThreadId: parent,
    parentThreadId: null,
    relationshipToParent: null,
  } as const;
  const child = {
    rootThreadId: parent,
    parentThreadId: parent,
    relationshipToParent: "subagent",
  } as const;

  it("counts listed threads and still deletes hidden children", () => {
    const plan = planProjectRemoval({
      members: [local],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: listed,
          sideChatOf: null,
        },
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: child,
          sideChatOf: null,
        },
        {
          environmentId: local.environmentId,
          projectId: local.id,
          lineage: listed,
          sideChatOf: parent,
        },
        {
          environmentId: remote.environmentId,
          projectId: remote.id,
          lineage: listed,
          sideChatOf: null,
        },
      ],
    });
    expect(plan.projectThreads).toHaveLength(3);
    expect(plan.confirmationMessage).toBe(
      'Remove checkout "Repo" and delete its 1 thread?\nPath: /work/repo\nEnvironment: Local\nThose threads and any archived threads are deleted from GOAT. Provider sessions are kept.\nOther entries in this grouped project are unaffected.\nThis action cannot be undone.',
    );
  });

  it("keeps an environment-filtered group scoped to its selected checkout", () => {
    const plan = planProjectRemoval({
      members: [remote],
      groupMemberCount: 1,
      hasOtherMembers: true,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("checkout");
    expect(plan.confirmationMessage).toContain("Environment: Remote");
    expect(plan.confirmationMessage).toContain(
      "Other entries in this grouped project are unaffected.",
    );
    expect(plan.confirmationMessage).toContain(
      "Any archived threads are deleted from GOAT. Provider sessions are kept.",
    );
  });

  // regression: #21409 project-wide removal must count every checkout's threads and keep files
  it("states the full group count and preserves files when removing a project everywhere", () => {
    const plan = planProjectRemoval({
      members: [local, remote],
      groupMemberCount: 2,
      hasOtherMembers: false,
      displayName: "Repo",
      threads: [],
    });
    expect(plan.targetKind).toBe("project");
    expect(plan.confirmationMessage).toContain("This removes 2 grouped project entries.");
    expect(plan.confirmationMessage).toContain(
      "This removes only the project entries, not the files on disk.",
    );
  });
});
