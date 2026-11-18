import { expect } from "vite-plus/test";
import * as Option from "effect/Option";
import {
  MemoryItem,
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
}: {
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
    scopeMoves: boolean,
  ) => Promise<unknown>;
  click: (label: string) => Promise<void>;
  chooseOption: (label: string, value: string) => Promise<void>;
}) {
  state.threads = [
    { id: "move-thread", title: "Move conversation", environmentId: "remote-owner" },
  ];
  state.queries.set(
    "list",
    Option.some({ items: [activeItem], projectionWatermark: 1, nextCursor: null }),
  );
  state.executors.set("move", async (target) => {
    state.calls(target);
    state.queries.set("list", Option.some({ items: [], projectionWatermark: 2, nextCursor: null }));
    return success({ outcome: "accepted", pendingSync: false });
  });
  await supportedScreen(true, false, false, true);
  await click("Move to…");
  await chooseOption("Memory scope", "thread");
  await chooseOption("Memory thread", "move-thread");
  await click("Move memory");
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
}
