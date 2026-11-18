import { describe, expect, it } from "vite-plus/test";
import { makeProviderSettingsSchema, ProviderDriverKind, TrimmedString } from "@goat/contracts";
import * as Schema from "effect/Schema";

import { providerClients } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("keeps every masked field as a stored secret", () => {
    const settingsSchema = makeProviderSettingsSchema({
      token: TrimmedString.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
    });

    expect(deriveProviderSettingsFields({ settingsSchema })).toMatchObject([
      { key: "token", secret: true },
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("does not store a text value its field's schema rejects", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    expect(claude).toBeDefined();
    const autoCompactWindow = deriveProviderSettingsFields(claude!).find(
      (field) => field.key === "autoCompactWindow",
    );
    expect(autoCompactWindow).toBeDefined();

    for (const invalid of ["300k", "50000"]) {
      expect(
        nextProviderConfigWithFieldValue({ launchArgs: "--x" }, autoCompactWindow!, invalid),
      ).toEqual({ launchArgs: "--x" });
    }
    expect(
      nextProviderConfigWithFieldValue({ launchArgs: "--x" }, autoCompactWindow!, "300000"),
    ).toEqual({ launchArgs: "--x", autoCompactWindow: "300000" });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });
});
