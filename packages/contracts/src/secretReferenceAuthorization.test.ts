import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerSettingsPatch, requiredScopesForServerSettingsPatch } from "./settings.ts";

const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
it("requires provider management for references in otherwise ordinary settings", () => {
  const patch = decodePatch({
    easDeviceHosts: [
      {
        kind: "eas",
        id: "eas",
        label: "Expo",
        accessTokenReference: { provider: "personal", reference: "op://vault/item/field" },
        maxSessionMinutes: 30,
        idleMinutes: 10,
        maxConcurrentSessions: 1,
      },
    ],
  });
  expect(requiredScopesForServerSettingsPatch(patch)).toEqual([
    "settings:write",
    "providers:manage",
  ]);
});
