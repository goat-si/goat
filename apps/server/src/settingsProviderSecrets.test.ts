import { AntigravitySettings, ProviderInstanceId, ServerSettings } from "@goat/contracts";
import { OpenCodeSettings } from "@goat/provider-opencode/settings";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { mapSettingsSecrets } from "./settingsSecrets.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeAntigravity = Schema.decodeUnknownSync(AntigravitySettings);
const decodeOpenCode = Schema.decodeUnknownSync(OpenCodeSettings);

it("keeps credential references intact in settings and continues to decode literals", () => {
  const reference = { provider: "vault", reference: "op://Work/item/password" };
  expect(decodeAntigravity({ apiKey: "literal" }).apiKey).toBe("literal");
  expect(decodeOpenCode({ serverPassword: "literal" }).serverPassword).toBe("literal");
  const settings = decodeSettings({
    providerInstances: {
      antigravity: { driver: "antigravity", config: { apiKey: reference } },
      opencode: { driver: "opencode", config: { serverPassword: reference } },
    },
  });
  const mapped = mapSettingsSecrets(settings, (secret) => secret);
  expect(mapped.providerInstances[ProviderInstanceId.make("antigravity")]?.config).toEqual({
    apiKey: reference,
  });
  expect(mapped.providerInstances[ProviderInstanceId.make("opencode")]?.config).toEqual({
    serverPassword: reference,
  });
});
