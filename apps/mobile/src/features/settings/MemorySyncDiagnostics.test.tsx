import { act } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import { WS_METHODS, type MemoryHubDiagnostics } from "@goat/contracts";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  nativeSpace,
  nativeSyncStatus,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
import { MemorySyncDiagnostics } from "./MemorySyncDiagnostics";
let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
});
const diagnostics: MemoryHubDiagnostics = {
  version: 7,
  publication: { state: "last_valid" },
  readiness: "ready",
  connection: "unreachable",
  recoverableHolds: ["availability"],
  permanentHolds: [],
  reconcile: "available",
};
async function mount(capability = true, write = true, projection = diagnostics) {
  h = createNativeMemoryHarness();
  const config = h.registry.get(h.configs(nativeEnv))!;
  // The synthetic session's initial config and the published config share this fixture.
  Object.assign(config.environment.capabilities.memory!, { hubDiagnostics: capability });
  h.grant(write ? ["memory:read", "settings:write"] : ["memory:read"]);
  h.responses.set(WS_METHODS.memoryHubDiagnostics, () => projection);
  h.responses.set(WS_METHODS.memoryHubReconcile, () => ({
    version: 7,
    rearmedClasses: ["availability"],
  }));
  await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
  view = renderNative(
    h,
    <MemorySyncDiagnostics
      environmentId={nativeEnv}
      status={nativeSyncStatus}
      onRefresh={async () => {
        await h.memory.syncStatus.run(h.registry, { environmentId: nativeEnv, input: {} });
      }}
    />,
  );
  await view.render();
}
it("shows last-valid disconnected readiness and rearms using the diagnostic version, then rereads both projections", async () => {
  await mount();
  expect(view.container.textContent).toContain("Hub disconnected");
  expect(view.container.textContent).toContain("Last valid settings in use");
  expect(view.container.textContent).not.toContain("Settings version");
  await view.click("Show sync details");
  expect(view.container.textContent).toContain("Settings version: 7");
  await view.click("Reconcile");
  expect(h.calls.filter((c) => c.method === WS_METHODS.memoryHubReconcile)).toMatchObject([
    {
      environmentId: nativeEnv,
      input: { environmentId: nativeEnv, memorySpaceId: nativeSpace, expectedVersion: 7 },
    },
  ]);
  expect(view.container.textContent).toContain(
    "Sync retry accepted. Synchronization may still be pending.",
  );
  expect(h.calls.filter((c) => c.method === WS_METHODS.memoryHubDiagnostics)).toHaveLength(2);
  expect(h.calls.filter((c) => c.method === WS_METHODS.memorySyncStatus)).toHaveLength(1);
});
it("does not dispatch diagnostics without capability", async () => {
  await mount(false);
  expect(h.calls).toHaveLength(0);
  expect(view.container.textContent).not.toContain("Reconcile");
});
it("keeps diagnostics readable without settings write and removes administration after revocation", async () => {
  await mount(true, false);
  expect(view.container.textContent).toContain("Last valid settings");
  expect(view.container.textContent).not.toContain("Reconcile");
  await act(async () => h.revoke());
  expect(view.container.textContent).not.toContain("Last valid settings");
});

it.each([
  ["disabled", "disabled", "Memory sharing off"],
  ["unbound", "unknown", "Connect a memory space"],
  ["staging", "connected", "Receiving initial memories"],
  ["ready", "connected", "Hub connected"],
] as const)(
  "shows %s readiness independently from the legacy online status",
  async (readiness, connection, label) => {
    await mount(true, true, {
      ...diagnostics,
      readiness,
      connection,
      reconcile: "unavailable",
      recoverableHolds: [],
      permanentHolds: ["identity", "authorization"],
    });
    expect(view.container.textContent).toContain(label);
    expect(view.container.textContent).toContain("identity hold");
    expect(view.container.textContent).toContain("access hold");
    expect(view.container.textContent).not.toContain("Reconcile");
  },
);
