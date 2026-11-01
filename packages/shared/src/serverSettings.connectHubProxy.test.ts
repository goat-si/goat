import { expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

it("keeps Connect standing consent across unrelated hub patches and supports withdrawal", () => {
  const allowed = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    hub: { connectDevicesHubProxy: true },
  });
  const changed = applyServerSettingsPatch(allowed, { hub: { cloudHolder: "auto" } });
  expect(changed.hub.connectDevicesHubProxy).toBe(true);
  const disabled = applyServerSettingsPatch(changed, { hub: { connectDevicesHubProxy: false } });
  expect(disabled.hub).toEqual({ ...changed.hub, connectDevicesHubProxy: false });
});
