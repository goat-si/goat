import { act } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  WS_METHODS,
  MemoryItem,
  MemoryHistoryPage,
  MemorySourcePage,
  MemoryRpcError,
  type MemoryUpsertInput,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  nativeSpace,
  nativeId,
  nativeItem,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
import { SettingsMemoryRouteScreen } from "./SettingsMemoryRouteScreen";

let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  vi.useRealTimers();
  await view?.unmount();
  h?.dispose();
});

if (nativeItem.status !== "active") throw new Error("Expected active fixture");
const startingRevision = nativeItem.revision.revisionId;
const decodeItem = Schema.decodeUnknownSync(MemoryItem);
const decodeHistory = Schema.decodeUnknownSync(MemoryHistoryPage);
const decodeSource = Schema.decodeUnknownSync(MemorySourcePage);
const savedElsewhere = decodeItem({
  ...nativeItem,
  revision: {
    ...nativeItem.revision,
    revisionId: "00000000-0000-4000-8000-0000000000a1",
    operationId: "00000000-0000-4000-8000-0000000000a2",
    payloadRef: "00000000-0000-4000-8000-0000000000a1",
  },
  payload: { ...nativeItem.payload, text: "Saved on another device" },
});
/** The revision the edit started from, held by a hold of this kind. */
const held = (reason: "scanner_pending" | "secret_detected") =>
  decodeItem({
    memorySpaceId: nativeSpace,
    memoryId: nativeId,
    status: "blocked",
    scope: { kind: "user" },
    failureCode: reason,
    pendingSync: false,
    localAvailability: {
      exposure: "held",
      reasons: [reason],
      deferred: [
        {
          kind: "scanner",
          state: reason === "scanner_pending" ? "pending" : "held",
          reason,
          revisionId: startingRevision,
          generation: 1,
          sinceAtUtc: "2026-10-15T00:00:00.000Z",
        },
      ],
      cleanupPending: false,
    },
  });
const heldForForget = decodeItem({
  memorySpaceId: nativeSpace,
  memoryId: nativeId,
  status: "blocked",
  scope: nativeItem.scope,
  failureCode: "forget_pending",
  pendingSync: false,
  localAvailability: {
    ...nativeItem.localAvailability,
    exposure: "held",
    reasons: ["forget_pending"],
  },
});
const savedByThisPhone = decodeItem({
  ...nativeItem,
  revision: {
    ...nativeItem.revision,
    revisionId: "00000000-0000-4000-8000-0000000000c1",
    operationId: "00000000-0000-4000-8000-0000000000c2",
    payloadRef: "00000000-0000-4000-8000-0000000000c1",
  },
  payload: { ...nativeItem.payload, text: "Saved by this phone" },
});
const accept = (input: unknown) => ({
  memoryId: (input as MemoryUpsertInput).memoryId,
  operationId: (input as MemoryUpsertInput).operationId,
  outcome: "accepted",
  pendingSync: false,
});
const CLOSED_LINE =
  "Edit closed because this memory is no longer the version you started from. Your unsaved text was not kept.";

async function openEditor(typed?: string) {
  h = createNativeMemoryHarness();
  await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
  view = renderNative(
    h,
    <SettingsMemoryRouteScreen
      route={{ params: { environmentId: nativeEnv, memorySpaceId: nativeSpace } }}
    />,
  );
  await view.render();
  await view.click("Open memory: Synthetic memory body");
  await view.click("Edit");
  if (typed !== undefined) await view.type("Memory text", typed);
}
const field = () =>
  view.container.querySelector<HTMLInputElement>('input[aria-label="Memory text"]');
const text = () => view.container.textContent ?? "";
const saveButton = () =>
  Array.from(view.container.querySelectorAll("button")).find(
    (button) => button.textContent === "Save memory",
  );
const target = {
  environmentId: nativeEnv,
  input: { memorySpaceId: nativeSpace, memoryId: nativeId },
};
const draft = () =>
  h.memory.draftAtom({
    environmentId: nativeEnv,
    input: { memorySpaceId: nativeSpace },
    draftId: `native:${nativeId}`,
  });
/** The reread has answered; what the shared draft decided is now on screen. */
async function answered() {
  await h.waitForAtom(h.memory.read.reply(target), (reply) => reply !== null);
  await act(async () => {});
}
/** The shared draft is gone, so whatever closed the editor has reached the screen. */
async function dropped() {
  await h.waitForAtom(draft(), (text) => text === null);
  await act(async () => {});
}
/** The minute runs out and the read reports the body expired, not still pending. */
async function expire() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(61_000);
  });
  await h.waitForAtom(
    h.memory.read.reply(target),
    (reply) => reply !== null && Option.isNone(reply),
  );
  await act(async () => {});
}
/** Another save of the open memory: its change signal, answered by the reread a test holds. */
async function changeSignal(kind: "upsert" | "invalidate" = "upsert") {
  const reply = h.deferred<MemoryItem>();
  h.responses.set(WS_METHODS.memoryRead, () => reply.response);
  await act(async () => {
    await h.signal({
      kind,
      memorySpaceId: nativeSpace,
      memoryId: nativeId,
      projectionWatermark: 2,
    });
  });
  return reply;
}

it("an edit the person changed keeps its text when the memory text expires, and Save sends it against the starting version (#3601)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await openEditor("Typed before the minute ran out");
  await expire();
  expect(field()?.value).toBe("Typed before the minute ran out");
  h.responses.set(WS_METHODS.memoryUpsert, accept);
  await view.click("Save memory");
  expect(h.calls.find((call) => call.method === WS_METHODS.memoryUpsert)?.input).toMatchObject({
    expectedHeads: [startingRevision],
    payload: { text: "Typed before the minute ran out" },
  });
  expect(field()).toBeNull();
});

it("an untouched edit closes when the memory text expires, says it was hidden, and Show again brings the text back (#3601)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await openEditor();
  await expire();
  expect(field()).toBeNull();
  expect(text()).toContain("Memory text hidden after a minute.");
  expect(text()).not.toContain("Synthetic memory body");
  // While the read Show again asked for is in flight, nothing new is shown.
  const shown = h.deferred<MemoryItem>();
  h.responses.set(WS_METHODS.memoryRead, () => shown.response);
  await view.click("Show again");
  expect(text()).not.toContain("Memory text hidden after a minute.");
  expect(text()).not.toContain("Memory details are unavailable");
  expect(text()).not.toContain("Memory unavailable");
  await act(async () => {
    await shown.succeed(nativeItem);
  });
  await answered();
  expect(text()).toContain("Synthetic memory body");
  expect(text()).not.toContain("Memory text hidden after a minute.");
});

it("typing survives the hub re-scanning the version the edit started from, and the scanner's release (#3601)", async () => {
  await openEditor("Typed while the hub confirms");
  const rescan = await changeSignal();
  await act(async () => {
    await rescan.succeed(held("scanner_pending"));
  });
  await answered();
  expect(field()?.value).toBe("Typed while the hub confirms");
  const release = await changeSignal("invalidate");
  await act(async () => {
    await release.succeed(nativeItem);
  });
  await answered();
  expect(field()?.value).toBe("Typed while the hub confirms");
  expect(text()).not.toContain(CLOSED_LINE);
});

it("an untouched edit closes without a line when the hub re-scans its version (#3601)", async () => {
  await openEditor();
  const rescan = await changeSignal();
  await act(async () => {
    await rescan.succeed(held("scanner_pending"));
  });
  await dropped();
  expect(field()).toBeNull();
  expect(text()).not.toContain(CLOSED_LINE);
});

it("masks both untouched and edited text until the same visible revision is confirmed (#3601)", async () => {
  await openEditor();
  const reread = await changeSignal();
  expect(field()?.value).toBe("");
  expect(field()?.disabled).toBe(true);
  expect(text()).not.toContain("Synthetic memory body");
  await act(async () => {
    await reread.succeed(nativeItem);
  });
  await answered();
  expect(field()?.value).toBe("Synthetic memory body");

  await view.type("Memory text", "Synthetic memory body!");
  const dirtyReread = await changeSignal("invalidate");
  expect(field()?.value).toBe("");
  expect(field()?.disabled).toBe(true);
  expect(saveButton()?.disabled).toBe(true);
  await act(async () => {
    await dirtyReread.succeed(nativeItem);
  });
  await answered();
  expect(field()?.value).toBe("Synthetic memory body!");
  expect(saveButton()?.disabled).toBe(false);
});

it("masks and then discards an edited copy when a pending forget holds the memory", async () => {
  await openEditor("Synthetic memory body!");
  const reread = await changeSignal("invalidate");
  expect(field()?.value).toBe("");
  expect(field()?.disabled).toBe(true);
  expect(saveButton()?.disabled).toBe(true);
  expect(text()).not.toContain("Synthetic memory body");
  await act(async () => {
    await reread.succeed(heldForForget);
  });
  await answered();
  expect(field()).toBeNull();
  expect(text()).not.toContain("Synthetic memory body");
  expect(text()).toContain(CLOSED_LINE);
});

it.each([
  ["another version", () => savedElsewhere],
  ["a detected secret", () => held("secret_detected")],
])("an edited draft closes with the line when the reread shows %s (#3601)", async (_, reread) => {
  await openEditor("Typed before the other change");
  const reply = await changeSignal();
  await act(async () => {
    await reply.succeed(reread());
  });
  await dropped();
  expect(field()).toBeNull();
  expect(text()).toContain(CLOSED_LINE);
  expect(text()).not.toContain("Typed before the other change");
});

it("an edited draft closes with the line when the reread fails (#3601)", async () => {
  await openEditor("Typed before the failed reread");
  const reply = await changeSignal();
  await act(async () => {
    await reply.fail(new Error("offline"));
  });
  await dropped();
  expect(field()).toBeNull();
  expect(text()).toContain(CLOSED_LINE);
});

it("a save whose own change signal arrives before its reply closes the editor without a line (#3601)", async () => {
  await openEditor("Saved by this phone");
  const reply = h.deferred<unknown>();
  h.responses.set(WS_METHODS.memoryUpsert, () => reply.response);
  await view.click("Save memory");
  const input = h.calls.find((call) => call.method === WS_METHODS.memoryUpsert)?.input;
  // The save's own change signal and its reread land first and drop the draft.
  const reread = await changeSignal();
  await act(async () => {
    await reread.succeed(savedByThisPhone);
  });
  await dropped();
  await act(async () => {
    await reply.succeed(accept(input));
  });
  expect(field()).toBeNull();
  expect(text()).not.toContain(CLOSED_LINE);
  expect(text()).not.toContain("The draft is no longer available");
  expect(text()).toContain("Saved by this phone");
});

it("typing is not replaced when the memory is read again (#3601)", async () => {
  await openEditor("Typed while it reloads");
  // An equal item in a new object, as every reply is.
  h.responses.set(WS_METHODS.memoryRead, () => decodeItem({ ...nativeItem }));
  await act(async () => h.registry.refresh(h.memory.read(target)));
  await answered();
  expect(field()?.value).toBe("Typed while it reloads");
});

it("guard: a forget closes the editor and drops its text (#3601)", async () => {
  await openEditor("Typed before the forget");
  await act(async () => {
    await h.signal({
      kind: "forget",
      memorySpaceId: nativeSpace,
      memoryId: nativeId,
      projectionWatermark: 2,
    });
  });
  await dropped();
  expect(field()).toBeNull();
  expect(text()).not.toContain("Typed before the forget");
});

const reject = (input: unknown) => ({
  ...accept(input),
  outcome: "rejected",
  failureCode: "revision_changed",
});
type SaveReply = ReturnType<NativeMemoryHarness["deferred"]>;
const replies = {
  accepted: (save: SaveReply, input: unknown) => save.succeed(accept(input)),
  refused: (save: SaveReply, input: unknown) => save.succeed(reject(input)),
  failed: (save: SaveReply) => save.fail(new Error("The memory service is unavailable.")),
};
/** Presses Save with its reply held, so the test decides when and how it answers. */
async function saveHeld() {
  const save = h.deferred<unknown>();
  h.responses.set(WS_METHODS.memoryUpsert, () => save.response);
  await view.click("Save memory");
  const input = h.calls.find((call) => call.method === WS_METHODS.memoryUpsert)?.input;
  return { save, input };
}

it.each([
  ["accepted", false],
  ["refused", true],
  ["failed", true],
] as const)(
  "guard: a hold during a save hides the typing immediately, then the %s reply closes the editor (#3601)",
  async (outcome, closedLine) => {
    await openEditor("Typed before the hold");
    const { save, input } = await saveHeld();
    const reread = await changeSignal("invalidate");
    expect(field()?.value).toBe("");
    expect(field()?.disabled).toBe(true);
    await act(async () => {
      await reread.succeed(held("secret_detected"));
    });
    await dropped();
    expect(field()?.value).toBe("");
    expect(text()).not.toContain("Typed before the hold");
    expect(text()).not.toContain("The draft is no longer available");
    await act(async () => {
      await replies[outcome](save, input);
    });
    expect(field()).toBeNull();
    expect(text()).not.toContain("Typed before the hold");
    expect(text().includes(CLOSED_LINE)).toBe(closedLine);
  },
);

it("guard: an untouched edit hides its text again on every later reread (#3601)", async () => {
  await openEditor();
  const first = await changeSignal("invalidate");
  await act(async () => {
    await first.succeed(nativeItem);
  });
  await answered();
  expect(field()?.value).toBe("Synthetic memory body");
  const second = await changeSignal("invalidate");
  expect(field()?.value).toBe("");
  expect(text()).not.toContain("Synthetic memory body");
  await act(async () => {
    await second.succeed(nativeItem);
  });
  await answered();
  expect(field()?.value).toBe("Synthetic memory body");
});

it.each(["refused", "failed"] as const)(
  "guard: after a %s save, a hold discards the typing and closes the editor with the line (#3601)",
  async (outcome) => {
    await openEditor("Typed before the save was turned down");
    const { save, input } = await saveHeld();
    await act(async () => {
      await replies[outcome](save, input);
    });
    expect(field()?.value).toBe("Typed before the save was turned down");
    const reread = await changeSignal("invalidate");
    expect(field()?.value).toBe("Typed before the save was turned down");
    await act(async () => {
      await reread.succeed(held("secret_detected"));
    });
    await dropped();
    expect(field()).toBeNull();
    expect(text()).toContain(CLOSED_LINE);
    expect(text()).not.toContain("Typed before the save was turned down");
  },
);

it.each(["rpc", "receipt"])("reviews a fresh revision after a stale save (%s)", async (kind) => {
  await openEditor("Stale draft");
  const { save, input } = await saveHeld();
  await act(async () => {
    if (kind === "rpc") await save.fail(new MemoryRpcError({ code: "revision_changed" }));
    else await save.succeed(reject(input));
  });
  expect(text()).toContain("This memory changed before your save.");
  expect(text()).not.toContain("Retry save request");
  expect(h.calls.filter((call) => call.method === WS_METHODS.memoryUpsert)).toHaveLength(1);

  h.responses.set(WS_METHODS.memoryRead, () => savedElsewhere);
  await view.click("Review latest memory");
  await answered();
  if (savedElsewhere.status !== "active") throw new Error("Active fixture required");
  const head = savedElsewhere.revision.revisionId;
  expect(text()).toContain("Saved on another device");
  expect(text()).toContain(`Current revision: ${head}`);
  expect(field()).toBeNull();
  await view.click("Edit");
  await view.type("Memory text", "Edit after review");
  h.responses.set(WS_METHODS.memoryUpsert, accept);
  await view.click("Save memory");

  const writes = h.calls.filter((call) => call.method === WS_METHODS.memoryUpsert);
  expect(writes).toHaveLength(2);
  expect(writes[1]?.input).toMatchObject({ expectedHeads: [head] });
  expect((writes[1]!.input as MemoryUpsertInput).operationId).not.toBe(
    (writes[0]!.input as MemoryUpsertInput).operationId,
  );
});
it.each([
  ["conflicted", false, "The save conflicted with another revision."],
  ["deleted", false, "This memory was deleted before the save applied."],
  ["accepted", true, "Save submitted for sync."],
] as const)(
  "reports the %s save receipt with pending sync %s",
  async (outcome, pendingSync, message) => {
    await openEditor("Typed update");
    h.responses.set(WS_METHODS.memoryUpsert, (input) => ({
      ...accept(input),
      outcome,
      pendingSync,
    }));
    await view.click("Save memory");
    expect(text()).toContain(message);
    expect(text()).not.toContain("Retry save request");
    expect(field() !== null).toBe(!pendingSync);
  },
);

it("hides current, historical, judgment and source text at expiry and across reconnect and route re-entry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  h = createNativeMemoryHarness();
  await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
  if (nativeItem.status !== "active" || savedElsewhere.status !== "active")
    throw new Error("Active fixtures required");
  const sourceThread = { environmentId: nativeEnv, threadId: "synthetic-source-thread" };
  const watermark = { fromEventId: "e1", toEventId: "e2", throughSequence: 2 };
  const body = decodeItem({
    ...nativeItem,
    payload: {
      ...nativeItem.payload,
      evidence: [{ origin: "thread", sourceThread, watermark, messageIds: ["source-1"] }],
    },
  });
  const history = decodeHistory({
    memoryId: nativeId,
    revisions: [
      {
        revision: savedElsewhere.revision,
        payload: { ...savedElsewhere.payload, text: "Retained history body" },
      },
    ],
    resolutions: [
      {
        resolution: {
          resolutionId: "00000000-0000-4000-8000-000000000022",
          memorySpaceId: nativeSpace,
          memoryId: nativeId,
          inputRevisionIds: [startingRevision, savedElsewhere.revision.revisionId],
          inputPayloadRefs: [nativeItem.revision.payloadRef, savedElsewhere.revision.payloadRef],
          judgmentRef: "00000000-0000-4000-8000-000000000022",
          requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
          effectiveProvider: "codex",
          effectiveModel: "synthetic",
          resolvingEnvironmentId: nativeEnv,
          fencingToken: 1,
          resultRevisionId: savedElsewhere.revision.revisionId,
          appliedAtUtc: "2026-10-14T00:00:00.000Z",
          revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
        },
        payload: {
          resolutionId: "00000000-0000-4000-8000-000000000022",
          judgment: "Retained judgment body",
        },
      },
    ],
    tombstone: null,
    reports: [],
    revertResults: [],
    localAvailability: nativeItem.localAvailability,
    nextCursor: null,
  });
  const source = decodeSource({
    sourceThread,
    watermark,
    messages: [{ messageId: "source-1", text: "Original source body" }],
    nextCursor: null,
  });
  const retained = h.deferred<MemoryHistoryPage>();
  h.responses.set(WS_METHODS.memoryRead, () => body);
  h.responses.set(WS_METHODS.memoryHistory, () => retained.response);
  h.responses.set(WS_METHODS.memoryReadSource, () => source);
  const linked = (
    <SettingsMemoryRouteScreen
      route={{
        params: { environmentId: nativeEnv, memorySpaceId: nativeSpace, memoryId: nativeId },
      }}
    />
  );
  view = renderNative(h, linked);
  await view.render();
  await answered();
  expect(text()).toContain("Close details");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
    await retained.succeed(history);
  });
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  await view.click("Read original on Test hub");
  const oldTexts = [
    "Synthetic memory body",
    "Retained history body",
    "Retained judgment body",
    "Original source body",
  ];
  for (const line of oldTexts) expect(text()).toContain(line);

  await act(async () => vi.advanceTimersByTimeAsync(41_000));
  await h.waitForAtom(
    h.memory.read.reply(target),
    (reply) => reply !== null && Option.isNone(reply),
  );
  expect(text()).toContain("Memory text hidden after a minute.");
  for (const line of oldTexts) expect(text()).not.toContain(line);

  const fresh = h.deferred<MemoryItem>();
  const freshHistory = h.deferred<MemoryHistoryPage>();
  h.responses.set(WS_METHODS.memoryRead, () => fresh.response);
  h.responses.set(WS_METHODS.memoryHistory, () => freshHistory.response);
  const prepared = h.prepared(nativeEnv);
  const connection = h.registry.get(prepared);
  await act(() => h.registry.set(prepared, Option.none()));
  await act(() =>
    h.registry.set(
      prepared,
      Option.map(connection, (value) => ({ ...value })),
    ),
  );
  await h.waitForCall(WS_METHODS.memoryRead, 2);
  for (const line of oldTexts) expect(text()).not.toContain(line);

  await view.rerender(<SettingsMemoryRouteScreen route={{ params: undefined }} />);
  await view.rerender(linked);
  await h.waitForCall(WS_METHODS.memoryRead, 3);
  for (const line of oldTexts) expect(text()).not.toContain(line);
  await act(async () => {
    await fresh.succeed(savedElsewhere);
  });
  await answered();
  expect(text()).toContain("Saved on another device");
  for (const line of oldTexts) expect(text()).not.toContain(line);
});

it("shows the fresh memory body after each of two consecutive upserts", async () => {
  await openEditor();
  await view.click("Close editor");
  const first = await changeSignal();
  await act(async () => {
    await first.succeed(savedElsewhere);
  });
  await answered();
  expect(text()).toContain("Saved on another device");
  const second = await changeSignal();
  await act(async () => {
    await second.succeed(savedByThisPhone);
  });
  await answered();
  expect(text()).toContain("Saved by this phone");
  expect(text()).not.toContain("Saved on another device");
});
