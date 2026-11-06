import { expect, it } from "vite-plus/test";
import { ServerSettings, UsageLimitSourceConfig } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { makeSecretResolver } from "../secrets/secretResolver.ts";
import { resolveUsageManagementKey } from "./UsageLimitSources.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
const decodeSource = Schema.decodeSync(UsageLimitSourceConfig);

it("resolves referenced usage keys through the shared cache and never falls back to a literal", async () => {
  const settings = decodeSettings({
    secretProviders: {
      personal: { kind: "one_password", label: "Vault", config: { account: "my.1password.com" } },
    },
  });
  const config = decodeSource({
    kind: "cliproxy",
    url: "https://hub.example.test",
    managementKey: "old-key",
    managementKeyReference: { provider: "personal", reference: "op://vault/item/field" },
  });
  let reads = 0;
  const resolve = makeSecretResolver(async () => {
    reads++;
    return "resolved-key";
  });
  expect(await resolveUsageManagementKey(settings, config, resolve)).toBe("resolved-key");
  expect(await resolveUsageManagementKey(settings, config, resolve)).toBe("resolved-key");
  expect(reads).toBe(1);
  resolve.invalidate();
  expect(await resolveUsageManagementKey(settings, config, resolve)).toBe("resolved-key");
  expect(reads).toBe(2);
  const failing = makeSecretResolver(async () => {
    throw new Error("private provider detail");
  });
  await expect(resolveUsageManagementKey(settings, config, failing)).rejects.toThrow(
    "Could not read secret from 1Password",
  );
});
