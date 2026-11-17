import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { applyServerSettingsPatch } from "./serverSettings.ts";

it("merges offered source control hosts per host, so turning one off keeps the others", () => {
  const off = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    offeredSourceControlProviders: { gitlab: false },
  });
  const both = applyServerSettingsPatch(off, {
    offeredSourceControlProviders: { bitbucket: false },
  });
  expect(both.offeredSourceControlProviders).toEqual({ gitlab: false, bitbucket: false });
  expect(
    applyServerSettingsPatch(both, { offeredSourceControlProviders: { gitlab: true } })
      .offeredSourceControlProviders,
  ).toEqual({ gitlab: true, bitbucket: false });
});
