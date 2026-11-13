import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { SETTINGS_ACCESS } from "./agentSurface/settingsAccess.ts";
import {
  DEFAULT_PEN_HUB_NODES,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

it("penHubNodes defaults on, turns off by patch, and only a person may change it", () => {
  expect(DEFAULT_PEN_HUB_NODES).toBe(true);
  expect(decodeServerSettings({}).penHubNodes).toBe(true);
  const input = { penHubNodes: false };
  expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
  expect(decodeServerSettingsPatch(input)).toEqual(input);
  expect(PROJECT_SCOPED_SERVER_SETTING_KEYS).not.toContain("penHubNodes");
  expect(SETTINGS_ACCESS.penHubNodes.access).toBe("person");
});
