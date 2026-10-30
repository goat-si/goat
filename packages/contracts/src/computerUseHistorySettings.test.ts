import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { SETTINGS_ACCESS } from "./agentSurface/settingsAccess.ts";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "./settings.ts";

it("keeps typed text off by default and reserves the setting for a person", () => {
  assert.equal(DEFAULT_SERVER_SETTINGS.computerUseKeepTypedText, false);
  assert.equal(SETTINGS_ACCESS.computerUseKeepTypedText.access, "person");
  assert.deepEqual(
    Schema.decodeUnknownSync(ServerSettingsPatch)({ computerUseKeepTypedText: true }),
    { computerUseKeepTypedText: true },
  );
});
