import { expect } from "vite-plus/test";
import { MemoryMutationReceipt, WS_METHODS, type MemoryForgetInput } from "@goat/contracts";
import {
  nativeId,
  nativeEnv,
  nativeSpace,
  nativeItem,
  type NativeMemoryHarness,
  type renderNative,
} from "../../testing/memoryNativeHarness";
import { MemoryHistoryPage } from "@goat/contracts";
import * as Schema from "effect/Schema";

const originalId = "00000000-0000-4000-8000-000000000003";
const resolutionId = "00000000-0000-4000-8000-000000000006";
const decodeHistory = Schema.decodeUnknownSync(MemoryHistoryPage);

export function revertHistory() {
  if (nativeItem.status !== "active") throw new Error("Expected active fixture");
  return decodeHistory({
    memoryId: nativeId,
    revisions: [
      {
        revision: { ...nativeItem.revision, revisionId: originalId, payloadRef: originalId },
        payload: nativeItem.status === "active" ? nativeItem.payload : null,
      },
    ],
    resolutions: [
      {
        resolution: {
          resolutionId,
          memorySpaceId: nativeSpace,
          memoryId: nativeId,
          inputRevisionIds: [originalId, "00000000-0000-4000-8000-000000000007"],
          inputPayloadRefs: [originalId, "00000000-0000-4000-8000-000000000007"],
          judgmentRef: resolutionId,
          requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
          effectiveProvider: "codex",
          effectiveModel: "synthetic",
          resolvingEnvironmentId: nativeEnv,
          fencingToken: 1,
          resultRevisionId: "00000000-0000-4000-8000-000000000004",
          appliedAtUtc: "2000-01-01T00:00:00.000Z",
          revertDeadlineUtc: "2000-01-31T00:00:00.000Z",
        },
        payload: { resolutionId, judgment: "Synthetic resolution" },
      },
    ],
    tombstone: null,
    reports: [],
    revertResults: [],
    localAvailability: nativeItem.localAvailability,
    nextCursor: null,
  });
}

const decodeReceipt = Schema.decodeUnknownSync(MemoryMutationReceipt);
export function receipt(input: unknown, rejected = false) {
  return decodeReceipt({
    operationId: (input as MemoryForgetInput).operationId,
    memoryId: nativeId,
    revisionId: null,
    outcome: rejected ? "rejected" : "deleted",
    pendingSync: !rejected,
    ...(rejected ? { failureCode: "revision_changed" } : {}),
  });
}

export async function exerciseMemoryMove(
  mount: (
    scopes: undefined,
    setup: (harness: NativeMemoryHarness) => void,
    capabilities: { protocolVersion: 1; scopeMoves: true },
  ) => Promise<void>,
  mounted: () => { h: NativeMemoryHarness; view: ReturnType<typeof renderNative> },
) {
  await mount(
    undefined,
    (harness) => {
      harness.projects.push({
        id: "move-project",
        title: "Move project",
        environmentId: nativeEnv,
        repositoryIdentity: null,
      });
      harness.responses.set(WS_METHODS.memoryProjectBindingGet, () => ({
        memorySpaceId: nativeSpace,
        project: { environmentId: nativeEnv, projectId: "move-project" },
        projectKey: { kind: "explicit", sharedProjectId: "move-key" },
        repositoryKey: null,
        version: 1,
      }));
      harness.responses.set(WS_METHODS.memoryMove, (input) => ({
        ...receipt(input),
        outcome: "accepted",
        pendingSync: false,
      }));
    },
    { protocolVersion: 1, scopeMoves: true },
  );
  const { h, view } = mounted();
  await view.click("Open memory: Synthetic memory body");
  await view.click("Move to…");
  await view.click("Move project");
  await view.click("Move memory");
  expect(h.calls.find((call) => call.method === WS_METHODS.memoryMove)?.input).toMatchObject({
    fromScope: { kind: "user" },
    toScope: { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "move-key" } },
  });
}
