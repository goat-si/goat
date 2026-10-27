import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationV2ThreadShellJson } from "./orchestrationV2.ts";

const shell = {
  id: "thread-test",
  projectId: "project-test",
  title: "Thread",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "thread-test", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "mobile",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
};

const decode = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
// A client built before the excerpt existed.
const decodePreExcerpt = Schema.decodeUnknownSync(
  OrchestrationV2ThreadShellJson.mapFields(
    ({ latestAnswerExcerpt: _excerpt, ...fields }) => fields,
  ),
);

describe("latest answer excerpt on thread shells", () => {
  it("reads shells from servers before and after the excerpt, and older clients ignore it", () => {
    expect(decode(shell).latestAnswerExcerpt).toBeUndefined();
    const withExcerpt = { ...shell, latestAnswerExcerpt: "PR #12 is open." };
    expect(decode(withExcerpt).latestAnswerExcerpt).toBe("PR #12 is open.");
    expect(decodePreExcerpt(withExcerpt)).toMatchObject({
      id: "thread-test",
    });
  });
});
