import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { SETTINGS_ACCESS } from "./agentSurface/settingsAccess.ts";
import { DEFAULT_PEN_HUB_NODES } from "./penSettings.ts";
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

it("penHubNodes defaults on, turns off by patch, and only a person may change it", () => {
  expect(DEFAULT_PEN_HUB_NODES).toBe(true);
  expect(decodeServerSettings({}).penHubNodes).toBe(true);
  const input = { penHubNodes: false };
  expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
  expect(decodeServerSettingsPatch(input)).toEqual(input);
  expect(PROJECT_SCOPED_SERVER_SETTING_KEYS).not.toContain("penHubNodes");
  expect(SETTINGS_ACCESS.penHubNodes.access).toBe("person");
});

it("showPenMachines defaults on and round-trips a disabled patch", () => {
  expect(decodeClientSettings({}).showPenMachines).toBe(true);
  expect(decodeClientSettings({ showPenMachines: false }).showPenMachines).toBe(false);
  const patch = decodeClientSettingsPatch({ showPenMachines: false });
  expect(patch.showPenMachines).toBe(false);
  expect(
    decodeClientSettings(encodeClientSettings(decodeClientSettings(patch))).showPenMachines,
  ).toBe(false);
});
