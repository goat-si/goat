import { act, StrictMode } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import {
  WS_METHODS,
  MemoryItem,
  MemoryMutationReceipt,
  type MemoryForgetInput,
  type MemoryUpsertInput,
} from "@goat/contracts";
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
  await view?.unmount();
  h?.dispose();
});
async function mount(strict = false) {
  h = createNativeMemoryHarness();
  await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
  const screen = (
    <SettingsMemoryRouteScreen
      route={{ params: { environmentId: nativeEnv, memorySpaceId: nativeSpace } }}
    />
  );
  view = renderNative(h, strict ? <StrictMode>{screen}</StrictMode> : screen);
  await view.render();
}
const field = () =>
  view.container.querySelector<HTMLInputElement>('input[aria-label="Memory text"]');
const decodeReceipt = Schema.decodeUnknownSync(MemoryMutationReceipt);
if (nativeItem.status !== "active") throw new Error("Expected active fixture");
const activeItem = nativeItem;
// The same memory after another device saved a new revision of it.
const editedElsewhere = Schema.decodeUnknownSync(MemoryItem)({
  ...activeItem,
  revision: {
    ...activeItem.revision,
    revisionId: "00000000-0000-4000-8000-0000000000a1",
    payloadRef: "00000000-0000-4000-8000-0000000000a1",
  },
  payload: { ...activeItem.payload, text: "Edited on another device" },
});

it("Save finishes after another device edits the memory while its editor is open (#3574)", async () => {
  await mount();
  await view.click("Open memory: Synthetic memory body");
  await view.click("Edit");
  h.responses.set(WS_METHODS.memoryRead, () => editedElsewhere);
  await act(async () => {
    await h.signal({
      kind: "upsert",
      memorySpaceId: nativeSpace,
      memoryId: nativeId,
      projectionWatermark: 2,
    });
  });
  expect(field()?.value).toBe("Edited on another device");
  await view.type("Memory text", "Typed after the other edit");
  h.responses.set(WS_METHODS.memoryUpsert, (input) => ({
    memoryId: (input as MemoryUpsertInput).memoryId,
    operationId: (input as MemoryUpsertInput).operationId,
    outcome: "accepted",
    pendingSync: false,
  }));
  await view.click("Save memory");
  expect(h.calls.filter((call) => call.method === WS_METHODS.memoryUpsert)).toHaveLength(1);
  expect(field()).toBeNull();
  expect(view.container.textContent).toContain("Close details");
});

it("Forget reports its result after the screen's effects run again, as under StrictMode or a development reload (#3574)", async () => {
  await mount(true);
  h.responses.set(WS_METHODS.memoryForget, (input) =>
    decodeReceipt({
      operationId: (input as MemoryForgetInput).operationId,
      memoryId: nativeId,
      revisionId: null,
      outcome: "rejected",
      pendingSync: false,
      failureCode: "revision_changed",
    }),
  );
  await view.click("Open memory: Synthetic memory body");
  await view.click("Forget");
  await view.click("Confirm forget");
  expect(view.container.textContent).toContain("Could not forget this memory. Review the record");
  const forget = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Forget",
  );
  expect(forget?.disabled).toBe(false);
});
