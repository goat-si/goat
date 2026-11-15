import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ClientSettingsPatch, ClientSettingsSchema } from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);

// Client settings stay on one device, so an older peer is the same device before an upgrade or
// after a downgrade.
const OlderClientSettings = ClientSettingsSchema.mapFields(Struct.omit(["language"]));
const decodeOlderClientSettings = Schema.decodeSync(OlderClientSettings);
const encodeOlderClientSettings = Schema.encodeSync(OlderClientSettings);

describe("ClientSettings language", () => {
  it("reads settings saved before the language setting as English", () => {
    expect(decodeClientSettings({}).language).toBe("en");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("language");
  });

  it("keeps a language an older client cannot show, and older clients decode around it", () => {
    const wire = encodeClientSettings(decodeClientSettings({ language: "it" }));
    expect(wire.language).toBe("it");
    expect(decodeClientSettingsPatch({ language: "system" })).toEqual({ language: "system" });

    const older = decodeOlderClientSettings(wire);
    expect(older).not.toHaveProperty("language");
    // An older client saves without the key, so a later upgrade reads English again.
    expect(decodeClientSettings(encodeOlderClientSettings(older)).language).toBe("en");
  });
});
