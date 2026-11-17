import { act } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { WS_METHODS, MemoryItem, type MemoryUpsertInput } from "@goat/contracts";
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

it("while a reread is pending an untouched edit hides its text and an edited one keeps it visible (#3601)", async () => {
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
  await view.type("Memory text", "Typed before the next change");
  await changeSignal();
  expect(field()?.value).toBe("Typed before the next change");
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
