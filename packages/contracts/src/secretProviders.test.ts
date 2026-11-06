import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ServerSettings,
  ServerSettingsPatch,
  requiredScopesForServerSettingsPatch,
} from "./settings.ts";
import { isOnePasswordReference } from "./secretReference.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

it("validates secret provider writes while retaining unknown stored providers", () => {
  const known = {
    kind: "one_password",
    label: "Personal",
    config: { account: "my.1password.com" },
  };
  const unknown = { kind: "future", label: "Vault", config: { credential: "private" } };
  expect(decodeServerSettingsPatch({ secretProviders: { personal: known } })).toEqual({
    secretProviders: { personal: known },
  });
  expect(
    requiredScopesForServerSettingsPatch(
      decodeServerSettingsPatch({ secretProviders: { personal: known } }),
    ),
  ).toEqual(["providers:manage"]);
  expect(() => decodeServerSettingsPatch({ secretProviders: { vault: unknown } })).toThrow();
  expect(() =>
    decodeServerSettingsPatch({
      secretProviders: { personal: { ...known, config: { account: "--help" } } },
    }),
  ).toThrow();
  expect(
    encodeServerSettings(decodeServerSettings({ secretProviders: { vault: unknown } }))
      .secretProviders,
  ).toEqual({ vault: unknown });
});

it("keeps environment secret references beside an empty value for older clients", () => {
  const instance = {
    driver: "codex",
    environment: [
      {
        name: "API_KEY",
        value: "",
        sensitive: true,
        secret: { provider: "personal", reference: "op://vault/item/field" },
      },
    ],
  };
  const decoded = decodeServerSettings({ providerInstances: { codex: instance } });
  expect(encodeServerSettings(decoded).providerInstances).toEqual({ codex: instance });
});

it("keeps a usage source secret reference beside the legacy string key", () => {
  const source = {
    kind: "cliproxy",
    url: "https://hub.example.test",
    managementKey: "",
    managementKeyReference: { provider: "personal", reference: "op://vault/item/field" },
    enabled: true,
  };
  expect(
    encodeServerSettings(decodeServerSettings({ usageLimitSources: { hub: source } }))
      .usageLimitSources,
  ).toEqual({ hub: source });
});

it("keeps an EAS token reference beside the legacy token string", () => {
  const host = {
    kind: "eas",
    id: "cloud",
    label: "Cloud",
    accessToken: "",
    accessTokenReference: { provider: "personal", reference: "op://vault/item/field" },
    maxSessionMinutes: 30,
    idleMinutes: 10,
    maxConcurrentSessions: 2,
  };
  expect(
    encodeServerSettings(decodeServerSettings({ easDeviceHosts: [host] })).easDeviceHosts,
  ).toEqual([host]);
});

it("accepts only 1Password read references without control or template characters", () => {
  expect(isOnePasswordReference("op://vault/item/field")).toBe(true);
  for (const value of [
    "not-a-reference",
    "op://vault/item",
    "op://vault/item/field\n--help",
    "op://vault/{{item}}/field",
  ]) {
    expect(isOnePasswordReference(value)).toBe(false);
  }
});
