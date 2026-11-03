import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ServerSettings,
  ServerSettingsPatch,
  requiredScopesForServerSettingsPatch,
} from "./settings.ts";

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
