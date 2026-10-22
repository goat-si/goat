import { EnvironmentId, ThreadId, type VcsStatusResult } from "@goat/contracts";
import {
  SshConnectionTarget,
  SshConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import { assert, describe, it } from "vite-plus/test";
import {
  isManagedSshProjectRoot,
  resolveSshFetchBackContext,
  buildMenuItems,
  requiresDefaultBranchConfirmation,
  resolveAutoFeatureBranchName,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
} from "./GitActionsControl.logic";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("when: ref is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: {
          number: 13,
          title: "Open PR",
          url: "https://example.com/pr/13",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "run_action", action: "push", label: "Push" });
  });
});

describe("when: ref is clean, up to date, and has no open PR", () => {
  it("enables create PR when synced with upstream but ahead of default, even with local changes", () => {
    const syncedFeature = status({
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 1,
      pr: null,
    });

    const quick = resolveQuickAction(syncedFeature, false);
    assert.deepInclude(quick, {
      label: "Create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });

    const items = buildMenuItems(syncedFeature, false);
    assert.equal(items.find((item) => item.id === "pr")?.disabled, false);

    const dirtyFeature = { ...syncedFeature, hasWorkingTreeChanges: true };
    assert.equal(
      buildMenuItems(dirtyFeature, false).find((item) => item.id === "pr")?.disabled,
      false,
    );
  });
});

describe("when: on default ref without open PR", () => {
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ refName: "main", hasWorkingTreeChanges: true }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });
});

describe("when: ref has no upstream configured", () => {
  it("resolveQuickAction runs push and create PR when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
      disabled: false,
    });
  });

  it("resolveQuickAction publishes when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
      false,
      false,
    );
    assert.deepEqual(quick, {
      kind: "open_publish",
      label: "Publish repository",
      disabled: false,
    });
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default ref", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("create_pr", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
    assert.isFalse(requiresDefaultBranchConfirmation("push", false));
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when git status is detached HEAD but the thread already has a ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: null }),
    });

    assert.equal(update, null);
  });

  it("does not regress a semantic thread ref back to a temporary worktree ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/github-query-rate-limit",
      gitStatus: status({ refName: "t3code/bda76797" }),
    });

    assert.equal(update, null);
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("increments suffix when the preferred ref name already exists", () => {
    const ref = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(ref, "feature/fix-toast-copy-3");
  });

  it("treats existing ref names as case-insensitive for collision checks", () => {
    const ref = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(ref, "feature/ticket-1-2");
  });
});

const localId = EnvironmentId.make("local");
const remoteId = EnvironmentId.make("remote");
const savedTarget = { alias: "build", hostname: "build.example", username: "dev", port: 2222 };
const savedRoute = {
  target: new SshConnectionTarget({
    environmentId: remoteId,
    connectionId: "saved",
    label: "Build",
  }),
  profile: Option.some(
    new SshConnectionProfile({
      environmentId: remoteId,
      connectionId: "saved",
      label: "Build",
      target: savedTarget,
    }),
  ),
};
const primaryEntry: ConnectionCatalogEntry = {
  target: new PrimaryConnectionTarget({
    environmentId: localId,
    label: "This device",
    httpBaseUrl: "http://localhost",
    wsBaseUrl: "ws://localhost",
  }),
  profile: Option.none(),
  enabled: true,
};
function fetchContext(overrides: Partial<Parameters<typeof resolveSshFetchBackContext>[0]> = {}) {
  return resolveSshFetchBackContext({
    isDesktop: true,
    threadRef: { environmentId: remoteId, threadId: ThreadId.make("thread") },
    thread: { branch: "feature/renamed" },
    workspaceRoot: "/home/dev/.goat/repos/app-12345678",
    primaryEnvironmentId: localId,
    catalog: new Map([
      [localId, primaryEntry],
      [remoteId, { ...savedRoute, enabled: true }],
    ]),
    ...overrides,
  });
}
describe("SSH fetch-back eligibility", () => {
  it("routes a renamed branch and the project root to the primary environment", () => {
    assert.deepEqual(fetchContext().target, {
      environmentId: localId,
      input: {
        target: savedTarget,
        remoteWorkspaceRoot: "/home/dev/.goat/repos/app-12345678",
        branch: "feature/renamed",
      },
    });
  });
  it("uses a saved alternate SSH route in preference order", () => {
    const secondRoute = {
      target: new SshConnectionTarget({
        environmentId: remoteId,
        connectionId: "second",
        label: "Other route",
      }),
      profile: Option.some(
        new SshConnectionProfile({
          environmentId: remoteId,
          connectionId: "second",
          label: "Other route",
          target: { ...savedTarget, port: 2223 },
        }),
      ),
    };
    const entry: ConnectionCatalogEntry = {
      target: new BearerConnectionTarget({
        environmentId: remoteId,
        connectionId: "direct",
        label: "Build",
      }),
      profile: Option.none(),
      alternateRoutes: [savedRoute, secondRoute],
      enabled: true,
    };
    assert.deepEqual(
      fetchContext({
        catalog: new Map([
          [localId, primaryEntry],
          [remoteId, entry],
        ]),
      }).target?.input.target,
      savedTarget,
    );
  });
  it("keeps Zulu preferred ahead of Alpha alternate, even for duplicate targets", () => {
    const route = (connectionId: string, label: string, port: number) => ({
      target: new SshConnectionTarget({ environmentId: remoteId, connectionId, label }),
      profile: Option.some(
        new SshConnectionProfile({
          environmentId: remoteId,
          connectionId,
          label,
          target: { ...savedTarget, port },
        }),
      ),
    });
    for (const alternatePort of [2222, 2223]) {
      const entry = {
        ...route("preferred", "Zulu preferred", 2222),
        enabled: true,
        alternateRoutes: [route("alternate", "Alpha alternate", alternatePort)],
      };
      const result = fetchContext({
        catalog: new Map([
          [localId, primaryEntry],
          [remoteId, entry],
        ]),
      });
      assert.deepEqual(result.target?.input.target, savedTarget);
    }
  });
  it("scopes saved targets before deduplicating another environment's identical host", () => {
    const otherId = EnvironmentId.make("other");
    const other = {
      enabled: true,
      target: new SshConnectionTarget({
        environmentId: otherId,
        connectionId: "other",
        label: "Alpha elsewhere",
      }),
      profile: Option.some(
        new SshConnectionProfile({
          environmentId: otherId,
          connectionId: "other",
          label: "Alpha elsewhere",
          target: savedTarget,
        }),
      ),
    };
    const result = fetchContext({
      catalog: new Map([
        [otherId, other],
        [localId, primaryEntry],
        [remoteId, { ...savedRoute, enabled: true }],
      ]),
    });
    assert.equal(result.visible, true);
    assert.deepEqual(result.target?.input.target, savedTarget);
  });
  it("keeps an unsupported saved environment visible with its reason", () => {
    const result = fetchContext({
      catalog: new Map([
        [localId, primaryEntry],
        [remoteId, { ...savedRoute, enabled: true, unsupportedReason: "Update GOAT" }],
      ]),
    });
    assert.equal(result.visible, true);
    assert.equal(result.target, null);
    assert.equal(result.disabledReason, "Update GOAT");
  });
  it("hides local, draft, unloaded, browser and unmanaged threads", () => {
    for (const patch of [
      { isDesktop: false },
      { threadRef: null },
      { thread: null },
      { workspaceRoot: null },
      { threadRef: { environmentId: localId, threadId: ThreadId.make("local-thread") } },
      { workspaceRoot: "/home/dev/work/app" },
    ])
      assert.equal(fetchContext(patch).visible, false);
  });
  it("hides unsaved and non-SSH environments", () => {
    assert.equal(fetchContext({ catalog: new Map([[localId, primaryEntry]]) }).visible, false);
    assert.equal(
      fetchContext({
        catalog: new Map([
          [localId, primaryEntry],
          [
            remoteId,
            {
              ...primaryEntry,
              target: new BearerConnectionTarget({
                environmentId: remoteId,
                connectionId: "direct",
                label: "Build",
              }),
            },
          ],
        ]),
      }).visible,
      false,
    );
  });
  it("refuses route/profile identity mismatch", () => {
    for (const fields of [
      { environmentId: localId, connectionId: "saved" },
      { environmentId: remoteId, connectionId: "other" },
    ]) {
      const profile = new SshConnectionProfile({ ...fields, label: "Other", target: savedTarget });
      assert.equal(
        fetchContext({
          catalog: new Map([
            [localId, primaryEntry],
            [
              remoteId,
              {
                ...savedRoute,
                profile: Option.some(profile),
                enabled: true,
              },
            ],
          ]),
        }).visible,
        false,
      );
    }
    assert.equal(
      fetchContext({
        catalog: new Map([
          [localId, primaryEntry],
          [
            remoteId,
            {
              ...savedRoute,
              target: new SshConnectionTarget({
                environmentId: localId,
                connectionId: "saved",
                label: "Wrong environment",
              }),
              enabled: true,
            },
          ],
        ]),
      }).visible,
      false,
    );
  });
  it("shows a disabled action for a disabled saved SSH environment", () => {
    const result = fetchContext({
      catalog: new Map([
        [localId, primaryEntry],
        [remoteId, { ...savedRoute, enabled: false }],
      ]),
    });
    assert.equal(result.visible, true);
    assert.equal(result.target, null);
    assert.match(result.disabledReason ?? "", /Enable this SSH environment/);
  });
  it("shows a disabled action when the primary connection is missing or disabled", () => {
    for (const result of [
      fetchContext({ primaryEnvironmentId: null }),
      fetchContext({ catalog: new Map([[remoteId, { ...savedRoute, enabled: true }]]) }),
      fetchContext({
        catalog: new Map([
          [localId, { ...primaryEntry, enabled: false }],
          [remoteId, { ...savedRoute, enabled: true }],
        ]),
      }),
    ]) {
      assert.equal(result.visible, true);
      assert.equal(result.target, null);
      assert.match(result.disabledReason ?? "", /Connect to this device/);
    }
  });
  it("shows a disabled action for a null or whitespace branch", () => {
    for (const branch of [null, "", "   "]) {
      const result = fetchContext({ thread: { branch } });
      assert.equal(result.visible, true);
      assert.equal(result.target, null);
      assert.match(result.disabledReason ?? "", /no branch/);
    }
  });
  it("rejects path traversal and lookalike directories", () => {
    for (const path of [
      "~/.goat/repos/app",
      "/home/dev/.goat/repos",
      "/home/dev/.goat/repos2/app",
      "/home/dev/not.goat/repos/app",
      "/home/dev/.goat/repos/../app",
      "/home/dev/.goat/repos/./app",
    ]) {
      assert.equal(isManagedSshProjectRoot(path), false);
    }
    assert.equal(isManagedSshProjectRoot("/Users/dev/.goat/repos/app-12345678/"), true);
  });
});
