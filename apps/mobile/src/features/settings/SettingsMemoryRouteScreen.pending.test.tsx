import { StrictMode } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import {
  WS_METHODS,
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

it("Save closes the editor after the editor's effects run again, as StrictMode does (#3574)", async () => {
  await mount(true);
  await view.click("Open memory: Synthetic memory body");
  await view.click("Edit");
  await view.type("Memory text", "Synthetic edited body");
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

it("Forget reports its result after the screen's effects run again, as StrictMode does (#3574)", async () => {
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
