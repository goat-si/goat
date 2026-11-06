import { expect, it } from "vite-plus/test";
import { ServerSettings, ServerSettingsPatch, UsageLimitSourceId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
const decodePatch = Schema.decodeSync(ServerSettingsPatch);

it("preserves an existing reference when an older client saves a source", () => {
  const source = {
    kind: "cliproxy",
    url: "https://hub.example.test",
    managementKey: "",
    enabled: true,
  } as const;
  const reference = { provider: "personal", reference: "op://vault/item/field" };
  const settings = decodeSettings({
    usageLimitSources: { hub: { ...source, managementKeyReference: reference } },
  });
  const patch = decodePatch({ usageLimitSources: { hub: source } });
  expect(
    applyServerSettingsPatch(settings, patch).usageLimitSources[UsageLimitSourceId.make("hub")]
      ?.managementKeyReference,
  ).toEqual(reference);
  const clear = decodePatch({
    usageLimitSources: { hub: { ...source, managementKeyReference: null } },
  });
  expect(
    applyServerSettingsPatch(settings, clear).usageLimitSources[UsageLimitSourceId.make("hub")]
      ?.managementKeyReference,
  ).toBeNull();
});

it("preserves an EAS reference in older client host updates and accepts an explicit clear", () => {
  const host = {
    kind: "eas",
    id: "cloud",
    label: "Cloud",
    accessToken: "",
    maxSessionMinutes: 30,
    idleMinutes: 10,
    maxConcurrentSessions: 2,
  } as const;
  const reference = { provider: "personal", reference: "op://vault/item/field" };
  const settings = decodeSettings({
    easDeviceHosts: [{ ...host, accessTokenReference: reference }],
  });
  expect(
    applyServerSettingsPatch(settings, decodePatch({ easDeviceHosts: [host] })).easDeviceHosts[0]
      ?.accessTokenReference,
  ).toEqual(reference);
  expect(
    applyServerSettingsPatch(
      settings,
      decodePatch({ easDeviceHosts: [{ ...host, accessTokenReference: null }] }),
    ).easDeviceHosts[0]?.accessTokenReference,
  ).toBeNull();
});
