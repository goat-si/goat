import { EnvironmentId, ProjectId } from "@goat/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  File: class {
    create() {}
  },
  Paths: { document: { uri: "file:///documents" } },
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "0000" }));
vi.mock("./assets", () => ({ assetEnvironment: {} }));
vi.mock("./attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("./session", () => ({ environmentSession: {} }));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  executeAtomQuery: () => {
    throw new Error("unexpected query");
  },
  runAtomCommand: () => {
    throw new Error("unexpected command");
  },
}));
vi.mock("../lib/attachmentUpload", () => ({ releasePendingAttachmentUploads: async () => {} }));
vi.mock("../features/sharing/incoming-share-storage", () => ({
  loadIncomingShareDrafts: async () => [],
}));

import { appAtomRegistry } from "./atom-registry";
import {
  clearComposerDraftContent,
  composerDraftsAtom,
  createNewTaskDraft,
  type ComposerDraft,
  findNewTaskDraftKeys,
  getComposerDraftSnapshot,
  migrateLegacyNewTaskDraft,
  retargetNewTaskDraft,
  setComposerDraftText,
  updateComposerDraftSettings,
} from "./use-composer-drafts";

const DRAFT: ComposerDraft = {
  text: "hello",
  attachments: [],
};

afterEach(() => {
  appAtomRegistry.set(composerDraftsAtom, {});
});

describe("new-task composer drafts", () => {
  it("migrates project-keyed new-task drafts to id keys with the project stamped in", () => {
    const now = "2026-09-05T12:00:00.000Z";
    const [key, draft] = migrateLegacyNewTaskDraft(
      "new-task:environment-1:project-1",
      { text: "keep me", attachments: [] },
      now,
    );

    expect(key).toMatch(/^new-task:[0-9a-z-]+$/);
    expect(draft).toEqual({
      text: "keep me",
      attachments: [],
      project: {
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
        createdAt: now,
      },
    });

    const stamped: ComposerDraft = {
      text: "x",
      attachments: [],
      project: {
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
        createdAt: now,
      },
    };
    expect(migrateLegacyNewTaskDraft("new-task:some-id", stamped, now)).toEqual([
      "new-task:some-id",
      stamped,
    ]);
    expect(migrateLegacyNewTaskDraft("environment-1:thread-1", DRAFT, now)).toEqual([
      "environment-1:thread-1",
      DRAFT,
    ]);
    expect(migrateLegacyNewTaskDraft("pending-task:message-1", DRAFT, now)).toEqual([
      "pending-task:message-1",
      DRAFT,
    ]);
  });

  it("keeps a freshly minted new-task draft bound until content arrives, then lists it per project", () => {
    const project = {
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
    };
    const first = createNewTaskDraft(project);
    const second = createNewTaskDraft(project);
    expect(first).not.toBe(second);

    expect(appAtomRegistry.get(composerDraftsAtom)[first]?.project).toMatchObject(project);

    setComposerDraftText(first, "first idea");
    setComposerDraftText(second, "second idea");
    expect(findNewTaskDraftKeys(appAtomRegistry.get(composerDraftsAtom), project)).toEqual(
      expect.arrayContaining([first, second]),
    );

    clearComposerDraftContent(first, { clearModelSelection: true, clearWorkspaceSelection: true });
    expect(appAtomRegistry.get(composerDraftsAtom)[first]).toBeUndefined();
    expect(getComposerDraftSnapshot(second).text).toBe("second idea");
  });

  it("retargets a new-task draft to another project, keeping only a pull request workspace", () => {
    const from = {
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
    };
    const to = {
      environmentId: EnvironmentId.make("environment-2"),
      projectId: ProjectId.make("project-2"),
    };
    const key = createNewTaskDraft(from);
    setComposerDraftText(key, "moving house");
    appAtomRegistry.set(composerDraftsAtom, {
      ...appAtomRegistry.get(composerDraftsAtom),
      [key]: {
        ...getComposerDraftSnapshot(key),
        runtimeMode: "approval-required",
        workspaceSelection: { mode: "worktree", branch: "feature/a", worktreePath: null },
      },
    });
    const createdAt = getComposerDraftSnapshot(key).project?.createdAt;

    retargetNewTaskDraft(key, to, { keepPullRequestWorkspace: true });

    const moved = getComposerDraftSnapshot(key);
    expect(moved.text).toBe("moving house");
    expect(moved.runtimeMode).toBe("approval-required");

    expect(moved.workspaceSelection).toBeUndefined();
    expect(moved.project).toEqual({ ...to, createdAt });
    expect(findNewTaskDraftKeys(appAtomRegistry.get(composerDraftsAtom), from)).toEqual([]);
    expect(findNewTaskDraftKeys(appAtomRegistry.get(composerDraftsAtom), to)).toEqual([key]);

    const pullRequestSelection = {
      mode: "worktree" as const,
      branch: "feature/pr-head",
      worktreePath: "/old-machine/worktrees/pr-42",
      startFromOrigin: false,
      pullRequestReference: "https://github.com/acme/repo/pull/42",
    };
    updateComposerDraftSettings(key, { workspaceSelection: pullRequestSelection });
    retargetNewTaskDraft(key, from, { keepPullRequestWorkspace: true });
    expect(getComposerDraftSnapshot(key).workspaceSelection).toEqual({
      ...pullRequestSelection,
      worktreePath: null,
    });
    retargetNewTaskDraft(key, to);
    expect(getComposerDraftSnapshot(key).workspaceSelection).toBeUndefined();
  });
});
