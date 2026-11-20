import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { ProviderAdapterV2Event as OldEvent } from "./ProviderAdapter.u39Base.testkit.ts";
import { ProviderAdapterV2Event as NewEvent } from "./ProviderAdapter.ts";

const decodeOld = Schema.decodeUnknownSync(OldEvent);
const decodeNew = Schema.decodeUnknownSync(NewEvent);

it("decodes provider title events both ways across the optional condition", () => {
  const now = DateTime.makeUnsafe("2026-11-20T00:00:00.000Z");
  const appThread = {
    id: "thread-title",
    projectId: "project-title",
    title: "New thread",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-title" },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const oldValue = { type: "app_thread.created", driver: "codex", appThread };
  const newer = decodeNew({ ...oldValue, onlyIfDefaultTitle: true });
  expect(newer).toHaveProperty("onlyIfDefaultTitle", true);
  expect(decodeOld(newer)).not.toHaveProperty("onlyIfDefaultTitle");
  expect(decodeNew(oldValue)).not.toHaveProperty("onlyIfDefaultTitle");
});
