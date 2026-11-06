import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { ProviderInstanceEnvironmentVariable } from "./providerInstance.ts";

const decode = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable);

it("marks stored secret references sensitive even if the stored flag is false", () => {
  const secret = { provider: "vault", reference: "op://Private/item/field" };
  for (const sensitive of [undefined, false, true]) {
    expect(decode({ name: "API_KEY", secret, sensitive }).sensitive).toBe(true);
  }
  expect(decode({ name: "PLAIN", value: "value", sensitive: false }).sensitive).toBe(false);
});
