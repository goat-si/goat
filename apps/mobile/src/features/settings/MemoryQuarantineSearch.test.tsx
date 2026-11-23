import { expect, it } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  nativeSpace,
} from "../../testing/memoryNativeHarness";
import { SettingsMemoryRouteScreen } from "./SettingsMemoryRouteScreen";

it("disables quarantine during submitted search and restores the browse preference", async () => {
  const h = createNativeMemoryHarness();
  await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
  const view = renderNative(
    h,
    <SettingsMemoryRouteScreen
      route={{ params: { environmentId: nativeEnv, memorySpaceId: nativeSpace } }}
    />,
  );
  try {
    await view.render();
    await view.click("Include quarantined");
    await view.type("Search memory", "absent");
    await view.click("Search");
    const toggle = [...view.container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
      (element) => element.textContent === "Include quarantined",
    )!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(view.container.textContent).toContain("Quarantined memories are excluded from search.");
    await view.click("Clear");
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  } finally {
    await view.unmount();
    h.dispose();
  }
});
