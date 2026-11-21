import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const oldSettings = Schema.Struct(
  Struct.omit(ServerSettings.fields, [
    "enableAgentThemeWrites",
    "defaultAppearance",
    "defaultAppearanceSetAt",
  ]),
);
const decodeOld = Schema.decodeUnknownSync(oldSettings);
const decodeNew = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

it("preserves old settings readers and defaults new readers to disabled", () => {
  const oldPayload = { enableProviderUpdateChecks: false };
  const oldResult = decodeOld(oldPayload);
  expect(
    decodeOld({
      ...oldPayload,
      enableAgentThemeWrites: true,
      defaultAppearance: "dark",
      defaultAppearanceSetAt: "stamp",
    }),
  ).toEqual(oldResult);
  expect(decodeNew(oldPayload).enableAgentThemeWrites).toBe(false);
  expect(decodeNew(oldPayload).defaultAppearance).toBe("");
  expect(decodeNew(oldPayload).defaultAppearanceSetAt).toBe("");
});

it("does not expose default theme selection through the generic patch", () => {
  expect(decodePatch({ defaultTheme: "grove", defaultThemeSetAt: "changed" })).toEqual({});
});
