import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsPatch, ClientSettingsSchema, DEFAULT_SERVER_SETTINGS } from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);

it("defaults old device settings to live transcription and keeps the choice client-local", () => {
  expect(decodeSettings({})).toHaveProperty("speechTranscribeAfterStop", false);
  expect(decodeSettings({ speechTranscribeAfterStop: true })).toHaveProperty(
    "speechTranscribeAfterStop",
    true,
  );
  expect(decodePatch({ speechTranscribeAfterStop: false })).toHaveProperty(
    "speechTranscribeAfterStop",
    false,
  );
  expect(DEFAULT_SERVER_SETTINGS).not.toHaveProperty("speechTranscribeAfterStop");
});
