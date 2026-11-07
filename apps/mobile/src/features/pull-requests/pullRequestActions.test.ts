import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import { describe, expect, it } from "vite-plus/test";
import {
  allowedMergeMethods,
  canPerformPullRequestAction,
  mergeSummary,
  mergeUnavailableReason,
  pullRequestActionLabel,
  ALL_PR_ACTIONS,
  mergeControlStatus,
  canExecuteImmediateMerge,
  pullRequestStateAction,
} from "./pullRequestActions";

const GITHUB = sourceControlClients.get("github").changeRequest;
const GITLAB = sourceControlClients.get("gitlab").changeRequest;

type Detail = Parameters<typeof allowedMergeMethods>[0];

function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    autoMergeEnabled: false,
    capabilities: {
      actions: ALL_PR_ACTIONS,
      mergeMethods: ["merge", "squash", "rebase"],
      updateMethods: ["merge", "rebase"],
    },
    viewerPermissions: { actions: ALL_PR_ACTIONS, updateMethods: ["merge"] },
    mergeCapabilities: { merge: true, squash: true, rebase: false },
    ...overrides,
  };
}

describe("mobile pull request actions", () => {
  it("offers only permitted state actions for the current request", () => {
    expect(pullRequestStateAction(detail(), true, false)).toBe("close");
    expect(pullRequestStateAction(detail({ state: "closed" }), true, false)).toBe("reopen");
    expect(pullRequestStateAction(detail({ state: "merged" }), true, false)).toBeNull();
    expect(pullRequestStateAction(detail(), false, false)).toBeNull();
    expect(pullRequestStateAction(detail(), true, true)).toBeNull();
    expect(
      pullRequestStateAction(detail({ viewerPermissions: { actions: [] } }), true, false),
    ).toBeNull();
  });

  it("blocks immediate merge while auto-merge is pending", () => {
    const pr = detail({ autoMergeEnabled: true });
    expect(canExecuteImmediateMerge(pr, true)).toBe(false);
    expect(mergeControlStatus(pr, false, false, false, GITHUB)?.label).toBe("Auto-merge pending");
    expect(canPerformPullRequestAction(pr, "disable-auto-merge")).toBe(true);
  });

  it("offers permitted ready and reopen actions and names terminal or conflicting states", () => {
    expect(mergeControlStatus(detail({ isDraft: true }), true, false, false, GITHUB)?.action).toBe(
      "ready",
    );
    expect(
      mergeControlStatus(detail({ state: "closed" }), true, false, false, GITHUB)?.action,
    ).toBe("reopen");
    expect(
      mergeControlStatus(detail({ state: "closed" }), false, false, false, GITHUB)?.label,
    ).toBe("Closed");
    expect(
      mergeControlStatus(detail({ state: "merged" }), false, false, false, GITHUB)?.label,
    ).toBe("Merged");
    expect(
      mergeControlStatus(detail({ mergeability: "conflicting" }), false, false, false, GITHUB)
        ?.label,
    ).toBe("Resolve conflicts to merge");
  });
  it("requires both provider support and account permission", () => {
    expect(
      canPerformPullRequestAction(detail({ viewerPermissions: { actions: [] } }), "merge"),
    ).toBe(false);
    expect(
      canPerformPullRequestAction(
        detail({ capabilities: { actions: [], mergeMethods: ["merge"] } }),
        "merge",
      ),
    ).toBe(false);
    expect(mergeUnavailableReason(detail(), false, GITHUB)).toContain("read-only");
  });

  it("blocks a conflicting PR's immediate merge and explains why", () => {
    const pr = detail({ mergeability: "conflicting" });
    expect(canPerformPullRequestAction(pr, "merge")).toBe(false);
    expect(mergeUnavailableReason(pr, true, GITHUB)).toContain("conflicts");
    expect(mergeSummary(pr, true, GITHUB)).toBe("Has conflicts");
  });

  it("names the change request with its host's term", () => {
    expect(pullRequestActionLabel("close", GITHUB)).toBe("Close pull request");
    expect(pullRequestActionLabel("close", GITLAB)).toBe("Close merge request");
    expect(pullRequestActionLabel("revert", GITLAB)).toBe("Create revert merge request");
    expect(mergeUnavailableReason(detail({ state: "merged" }), true, GITLAB)).toBe(
      "This merge request has been merged.",
    );
  });
});
