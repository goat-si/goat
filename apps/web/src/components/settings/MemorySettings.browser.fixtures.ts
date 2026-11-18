import { expect } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import {
  MemoryItem,
  MemoryRpcError,
  type MemoryMoveInput,
  MemoryRevision,
  MemoryResolution,
  MemoryResolutionPayload,
  MemoryRevertResult,
  type MemoryHistoryPage,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const item = Schema.decodeSync(MemoryItem)({
  memorySpaceId: id(1),
  memoryId: id(2),
  status: "blocked",
  scope: { kind: "user" },
  failureCode: "secret_detected",
  pendingSync: false,
  localAvailability: {
    exposure: "held",
    reasons: ["secret_detected"],
    deferred: [],
    cleanupPending: false,
  },
});
const decodeItem = Schema.decodeSync(MemoryItem);
const decodeRevision = Schema.decodeSync(MemoryRevision);
export const decodeRevert = Schema.decodeUnknownSync(MemoryRevertResult);
export const revision = (n: number) =>
  decodeRevision({
    memorySpaceId: id(1),
    memoryId: id(2),
    revisionId: id(n),
    operationId: id(10 + n),
    parents: [],
    scope: { kind: "user" },
    payloadRef: id(n),
    assertionKind: "fact",
    provenance: { environmentId: "remote-owner" },
    createdAtUtc: "2026-09-01T00:00:00.000Z",
  });
export const payload = {
  text: "Synthetic original",
  evidence: [{ origin: "user" as const, messageIds: [] }],
  derivedFromMemoryRevisions: [],
};
export const activeItem = Schema.decodeSync(MemoryItem)({
  memorySpaceId: item.memorySpaceId,
  memoryId: item.memoryId,
  scope: { kind: "user" },
  pendingSync: false,
  status: "active",
  revision: revision(5),
  payload,
  localAvailability: { exposure: "visible", reasons: [], deferred: [], cleanupPending: false },
});
export const resolution = Schema.decodeSync(MemoryResolution)({
  resolutionId: id(6),
  memorySpaceId: id(1),
  memoryId: id(2),
  inputRevisionIds: [id(3), id(4)],
  inputPayloadRefs: [id(3), id(4)],
  judgmentRef: id(6),
  requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
  effectiveProvider: "codex",
  effectiveModel: "synthetic",
  resolvingEnvironmentId: "remote-owner",
  fencingToken: 1,
  resultRevisionId: id(5),
  appliedAtUtc: "2026-09-01T00:00:00.000Z",
  revertDeadlineUtc: "2026-10-01T00:00:00.000Z",
});
export const entry = {
  resolution,
  payload: MemoryResolutionPayload.make({
    resolutionId: resolution.resolutionId,
    judgment: "Synthetic judgment",
  }),
};
export const retained = {
  revisions: [
    { revision: revision(3), payload },
    { revision: revision(4), payload: null },
  ],
  revertResults: [],
  nextCursor: null,
} satisfies Pick<MemoryHistoryPage, "revisions" | "revertResults" | "nextCursor">;

export async function exerciseMemoryMove({
  state,
  success,
  supportedScreen,
  click,
  chooseOption,
  container,
  batch,
  select,
}: {
  batch: boolean;
  select: (button: HTMLInputElement) => Promise<void>;
  container: HTMLElement;
  state: {
    threads: { id: string; title: string; environmentId: string }[];
    queries: Map<string, unknown>;
    executors: Map<string, (target: unknown) => Promise<unknown>>;
    calls: (target: unknown) => void;
    refresh: unknown;
  };
  success: (value: unknown) => unknown;
  supportedScreen: (
    withDetails: boolean,
    followNavigation: boolean,
    originFilter: boolean,
    capabilities: { protocolVersion: 1; scopeMoves: true },
  ) => Promise<{ render: () => Promise<void> }>;
  click: (label: string) => Promise<void>;
  chooseOption: (label: string, value: string, section?: string) => Promise<void>;
}) {
  state.threads = [
    { id: "move-thread", title: "Move conversation", environmentId: "remote-owner" },
  ];
  if (activeItem.status !== "active") throw new Error("Expected an active fixture");
  const items = batch
    ? [
        activeItem,
        ...[211, 212].map((n) =>
          decodeItem({
            ...activeItem,
            memoryId: id(n),
            revision: {
              ...activeItem.revision,
              memoryId: id(n),
              revisionId: id(n + 10),
              payloadRef: id(n + 10),
            },
            payload: { ...activeItem.payload, text: `Synthetic move item ${n}` },
          }),
        ),
      ]
    : [activeItem];
  state.queries.set("list", Option.some({ items, projectionWatermark: 1, nextCursor: null }));
  const attempts = new Map<string, string[]>();
  state.executors.set("move", async (target) => {
    const { input } = target as { input: MemoryMoveInput };
    const ids = attempts.get(input.memoryId) ?? [];
    ids.push(input.operationId);
    attempts.set(input.memoryId, ids);
    state.calls(target);
    if (input.memoryId === activeItem.memoryId && ids.length === 1)
      return {
        _tag: "Failure",
        cause: Cause.fail(
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
        ),
      };
    if ((!batch && ids.length === 2) || (input.memoryId === id(211) && ids.length === 1))
      return { _tag: "Failure", cause: Cause.die(new Error("Synthetic lost acknowledgement")) };
    if (input.memoryId === (batch ? id(211) : activeItem.memoryId))
      state.queries.set(
        "list",
        Option.some({ items: [], projectionWatermark: 2, nextCursor: null }),
      );
    return success({ outcome: "accepted", pendingSync: false });
  });
  const { render } = await supportedScreen(!batch, false, false, {
    protocolVersion: 1,
    scopeMoves: true,
  });
  if (batch) {
    await click("Select memories");
    for (const checkbox of container.querySelectorAll<HTMLInputElement>(
      'input[aria-label^="Select "]',
    ))
      await select(checkbox);
  }
  await click("Move to…");
  await chooseOption("Memory scope", "thread", '[aria-label="Move memories"]');
  await chooseOption("Memory thread", "move-thread", '[aria-label="Move memories"]');
  const submit = async () => {
    const label = [...container.querySelectorAll("button")].find((button) =>
      /^Move (?:memory|\d+ memories)$/.test(button.textContent ?? ""),
    )?.textContent;
    if (!label) throw new Error("Expected a move action");
    await click(label);
  };
  await submit();
  const firstNotice = container.textContent ?? "";
  await submit();
  if (!batch) await submit();
  const capacity = attempts.get(activeItem.memoryId) ?? [];
  expect(capacity).toHaveLength(batch ? 2 : 3);
  expect(capacity[1]).not.toBe(capacity[0]);
  if (batch) {
    const uncertain = attempts.get(id(211)) ?? [];
    expect(uncertain).toHaveLength(2);
    expect(uncertain[1]).toBe(uncertain[0]);
    expect(attempts.get(id(212))).toHaveLength(1);
  } else expect(capacity[2]).toBe(capacity[1]);
  expect(firstNotice).toContain("destination is full");
  expect(state.calls).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        fromScope: { kind: "user" },
        toScope: {
          kind: "thread",
          thread: { environmentId: "remote-owner", threadId: "move-thread" },
        },
      }),
    }),
  );
  expect(state.refresh).toHaveBeenCalled();
  await render();
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Open"),
  ).toBe(false);
}
