import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

it("lists no offered source control host by default, which offers every host, and validates its patch", () => {
  expect(decodeServerSettings({}).offeredSourceControlProviders).toEqual({});
  expect(decodeServerSettingsPatch({ offeredSourceControlProviders: { gitcafe: false } })).toEqual({
    offeredSourceControlProviders: { gitcafe: false },
  });
  expect(() =>
    decodeServerSettingsPatch({ offeredSourceControlProviders: { gitcafe: "off" } }),
  ).toThrow();
});
