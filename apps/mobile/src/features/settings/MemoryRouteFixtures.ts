import { expect, vi } from "vite-plus/test";
import { act } from "react";
import { suggestionScenario } from "../../../../web/src/test/memorySuggestionsFixture";
import {
  MemoryHistoryPage,
  MemoryItem,
  MemoryMutationReceipt,
  MemoryRpcError,
  MemoryId,
  MemoryRevisionId,
  type MemoryMoveInput,
  WS_METHODS,
  type MemoryForgetInput,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
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
  batch: boolean | "forget" | "expiry" | "hold",
) {
  const active = nativeItem;
  if (active.status !== "active") throw new Error("Expected active fixture");
  const others = [211, 212].map((n) => {
    const memoryId = MemoryId.make(`00000000-0000-4000-8000-000000000${n}`);
    const revisionId = MemoryRevisionId.make(`00000000-0000-4000-8000-000000000${n + 10}`);
    return {
      ...active,
      memoryId,
      revision: { ...active.revision, memoryId, revisionId, payloadRef: revisionId },
      payload: { ...active.payload, text: `Synthetic move item ${n}` },
    };
  });
  const items = batch ? [active, ...others] : [active];
  const uncertainId = others[0]?.memoryId;
  const completedId = others[1]?.memoryId;
  const attempts = new Map<string, string[]>();
  let heldMove: ((value: unknown) => Promise<unknown>) | undefined;
  if (batch === "expiry") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
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
        harness.responses.set(WS_METHODS.memoryList, () => ({
          items,
          nextCursor: null,
          projectionWatermark: 1,
        }));
        const pending = harness.deferred();
        heldMove = pending.succeed;
        harness.responses.set(WS_METHODS.memoryMove, (wire) => {
          const input = wire as MemoryMoveInput;
          const ids = attempts.get(input.memoryId) ?? [];
          ids.push(input.operationId);
          attempts.set(input.memoryId, ids);
          if (input.memoryId === nativeId && ids.length === 1)
            return Effect.fail(
              new MemoryRpcError({
                code: "capacity_exceeded",
                capacity: {
                  code: "capacity_exceeded",
                  dimension: "thread_items",
                  current: 2,
                  limit: 1,
                  reclaimable: 0,
                },
              }),
            );
          if (typeof batch === "string" && input.memoryId === nativeId && ids.length === 2)
            return pending.response;
          if ((!batch && ids.length === 2) || (input.memoryId === uncertainId && ids.length === 1))
            return Effect.die(new Error("Synthetic lost acknowledgement"));
          if (input.memoryId === (batch ? uncertainId : nativeId))
            harness.responses.set(WS_METHODS.memoryList, () => ({
              items: [],
              nextCursor: null,
              projectionWatermark: 2,
            }));
          return {
            ...receipt(input),
            memoryId: input.memoryId,
            outcome: "accepted",
            pendingSync: false,
          };
        });
      },
      { protocolVersion: 1, scopeMoves: true },
    );
    const { h, view } = mounted();
    if (batch) {
      await view.click("Select memories");
      await view.click("Select memory 00000002");
      await view.click("Select memory 00000211");
      await view.click("Select memory 00000212");
    } else await view.click("Open memory: Synthetic memory body");
    await view.click("Move to…");
    await view.click("Move project");
    const submit = async () => {
      const label = view.container.textContent?.match(/Move (?:[0-9]+ memories|memory)/)?.[0];
      if (!label) throw new Error("Expected a move action");
      await view.click(label);
    };
    await submit();
    const firstNotice = view.container.textContent;
    if (typeof batch === "string") {
      expect.soft(firstNotice).not.toContain("Synthetic move item 211 ·");
      await submit();
      const waiting = h.calls.filter(({ method }) => method === WS_METHODS.memoryMove).at(-1);
      if (!waiting || !heldMove || !uncertainId) throw new Error("Expected a pending move");
      if (batch === "expiry") {
        await act(() => vi.advanceTimersByTimeAsync(61_000));
      } else {
        const held = MemoryItem.make({
          memorySpaceId: nativeSpace,
          memoryId: uncertainId,
          status: "blocked",
          scope: active.scope,
          pendingSync: false,
          failureCode: "secret_detected",
          localAvailability: {
            ...active.localAvailability,
            exposure: "held",
            reasons: ["secret_detected"],
          },
        });
        h.responses.set(WS_METHODS.memoryList, () => ({
          items: items.flatMap<MemoryItem>((memory) =>
            memory.memoryId !== uncertainId ? [memory] : batch === "hold" ? [held] : [],
          ),
          nextCursor: null,
          projectionWatermark: 2,
        }));
        await act(async () => {
          await h.signal({
            kind: batch === "forget" ? "forget" : "invalidate",
            memorySpaceId: nativeSpace,
            memoryId: uncertainId,
            projectionWatermark: 2,
          });
        });
      }
      expect.soft(view.container.outerHTML).not.toContain("Synthetic move item 211");
      const input = waiting.input as MemoryMoveInput;
      await act(async () => {
        await heldMove?.({ ...receipt(input), outcome: "accepted", pendingSync: false });
      });
      expect.soft(attempts.get(uncertainId)).toHaveLength(1);
      expect(view.container.outerHTML).not.toContain("Synthetic move item 211");
      return;
    }
    await submit();
    if (!batch) await submit();
    const capacity = attempts.get(nativeId) ?? [];
    expect(capacity).toHaveLength(batch ? 2 : 3);
    expect(capacity[1]).not.toBe(capacity[0]);
    if (batch && uncertainId && completedId) {
      const uncertain = attempts.get(uncertainId) ?? [];
      expect(uncertain).toHaveLength(2);
      expect(uncertain[1]).toBe(uncertain[0]);
      expect(attempts.get(completedId)).toHaveLength(1);
    } else expect(capacity[2]).toBe(capacity[1]);
    expect(firstNotice).toContain("destination is full");
    expect(view.container.textContent).not.toContain("Synthetic memory body");
    expect(h.calls.find((call) => call.method === WS_METHODS.memoryMove)?.input).toMatchObject({
      fromScope: { kind: "user" },
      toScope: { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "move-key" } },
    });
  } finally {
    if (batch === "expiry") vi.useRealTimers();
  }
}
