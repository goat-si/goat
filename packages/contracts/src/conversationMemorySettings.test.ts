import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  requiredScopesForServerSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

it("defaults conversation memory on for existing environments and protects the pause switch", () => {
  expect(decodeServerSettings({}).conversationMemoryEnabled).toBe(true);
  for (const enabled of [false, true]) {
    const patch = { conversationMemoryEnabled: enabled };
    expect(decodeServerSettings(patch).conversationMemoryEnabled).toBe(enabled);
    expect(decodeServerSettingsPatch(patch)).toEqual(patch);
    expect(requiredScopesForServerSettingsPatch(patch)).toEqual(["settings:write"]);
  }
  expect(() => decodeServerSettingsPatch({ conversationMemoryEnabled: "off" })).toThrow();
});
