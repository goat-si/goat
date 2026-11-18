import { expect } from "vite-plus/test";
import { act } from "react";
import { suggestionScenario } from "../../../../web/src/test/memorySuggestionsFixture";
import {
  MemoryHistoryPage,
  MemoryMutationReceipt,
  WS_METHODS,
  type MemoryForgetInput,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import {
  nativeSpace,
  nativeId,
  nativeEnv,
  nativeItem,
  nativeSyncStatus,
  type NativeMemoryHarness,
  type renderNative,
} from "../../testing/memoryNativeHarness";

export {
  legacyMemoryCapabilities,
  suggestionMemoryCapabilities,
  suggestionScenario,
} from "../../../../web/src/test/memorySuggestionsFixture";

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

export const importFixtureSourceId = "00000000-0000-4000-8000-000000000025";

export function mockMemoryImport(harness: NativeMemoryHarness, count: number) {
  harness.responses.set(WS_METHODS.memoryImportProvider, (value) => {
    const input = value as {
      action: string;
      operationId: string;
      items: Array<{ sourceItemKey: string }>;
    };
    if (input.action === "discover")
      return {
        action: "discover",
        sources: [
          {
            sourceId: importFixtureSourceId,
            format: "codex",
            parserVersion: "1",
            profile: "private-profile",
            label: "/private/path",
          },
        ],
      };
    if (input.action === "preview")
      return {
        action: "preview",
        sourceId: importFixtureSourceId,
        sessionId: "synthetic-session",
        items: Array.from({ length: count }, (_, index) => ({
          sourceItemKey: `key-${index}`,
          sourceFingerprint: "a".repeat(64),
          byteCount: 10,
          mappingRequired: true,
          title: `Import memory ${index + 1}`,
        })),
      };
    return {
      action: input.action,
      receipt: {
        operationId: input.operationId,
        sourceId: importFixtureSourceId,
        sessionId: "synthetic-session",
        sessionNewItems: 1,
        sessionBodyBytes: 10,
        state: "completed",
        items:
          input.items?.map((item) => ({
            sourceItemKey: item.sourceItemKey,
            outcome: "created",
            memoryId: null,
            revisionId: null,
          })) ?? [],
        remaining: 0,
      },
      syncStatus: nativeSyncStatus,
    };
  });
}

export function mockStagedSuggestion(harness: NativeMemoryHarness) {
  const { refused, accept, accepting, unpublished } = suggestionScenario;
  harness.responses.set(WS_METHODS.memoryList, () => unpublished);
  harness.responses.set(WS_METHODS.memorySuggestionsList, () => refused);
  harness.responses.set(WS_METHODS.memorySuggestionsAccept, () => {
    harness.responses.set(WS_METHODS.memorySuggestionsList, () => accepting);
    return accept;
  });
}

export function mockDismissibleSuggestion(harness: NativeMemoryHarness) {
  const { dismissible, dismiss, dismissed, published } = suggestionScenario;
  harness.responses.set(WS_METHODS.memoryList, () => published);
  harness.responses.set(WS_METHODS.memorySuggestionsList, () => dismissible);
  harness.responses.set(WS_METHODS.memorySuggestionsDismiss, () => {
    harness.responses.set(WS_METHODS.memorySuggestionsList, () => dismissed);
    return dismiss;
  });
}

export async function replaySuggestionChange(
  harness: NativeMemoryHarness,
  kind: "upsert" | "forget",
) {
  const { settled, published, forgotten, afterForget } = suggestionScenario;
  const [memory] = published.items;
  if (!memory) throw new Error("Expected a published fixture memory");
  const page = kind === "upsert" ? published : afterForget;
  harness.responses.set(WS_METHODS.memoryList, () => page);
  harness.responses.set(WS_METHODS.memorySuggestionsList, () =>
    kind === "upsert" ? settled : forgotten,
  );
  await act(async () => {
    await harness.signal({
      kind,
      memorySpaceId: nativeSpace,
      memoryId: memory.memoryId,
      projectionWatermark: page.projectionWatermark,
    });
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
      harness.responses.set(WS_METHODS.memoryMove, (input) => {
        harness.responses.set(WS_METHODS.memoryList, () => ({
          items: [],
          nextCursor: null,
          projectionWatermark: 2,
        }));
        return { ...receipt(input), outcome: "accepted", pendingSync: false };
      });
    },
    { protocolVersion: 1, scopeMoves: true },
  );
  const { h, view } = mounted();
  await view.click("Open memory: Synthetic memory body");
  await view.click("Move to…");
  await view.click("Move project");
  await view.click("Move memory");
  expect(view.container.textContent).not.toContain("Synthetic memory body");
  expect(h.calls.find((call) => call.method === WS_METHODS.memoryMove)?.input).toMatchObject({
    fromScope: { kind: "user" },
    toScope: { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "move-key" } },
  });
}
