import { expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerSettings, SecretReference } from "@goat/contracts";
import { makeSecretResolver, resolveSecret } from "./secretResolver.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeReference = Schema.decodeUnknownSync(SecretReference);

it("resolves a reference through its configured account without exposing the value", async () => {
  const settings = decodeSettings({
    secretProviders: {
      vault: { kind: "one_password", label: "Vault", config: { account: "team" } },
    },
  });
  const reference = decodeReference({ provider: "vault", reference: "op://work/item/password" });
  const read = vi.fn().mockResolvedValue("fixture-secret");
  await expect(resolveSecret(settings.secretProviders, reference, read)).resolves.toBe(
    "fixture-secret",
  );
  expect(read).toHaveBeenCalledWith("team", "op://work/item/password");
});

it("refuses missing, unknown and invalid provider configurations without reading", async () => {
  const reference = decodeReference({ provider: "vault", reference: "op://work/item/password" });
  const read = vi.fn();
  for (const secretProviders of [
    {},
    { vault: { kind: "unknown", label: "Vault", config: {} } },
    { vault: { kind: "one_password", label: "Vault", config: { account: "--help" } } },
  ]) {
    const settings = decodeSettings({ secretProviders });
    await expect(resolveSecret(settings.secretProviders, reference, read)).rejects.toThrow(
      "Secret provider unavailable",
    );
  }
  expect(read).not.toHaveBeenCalled();
});

it("reuses a bounded cached value and reads again after the cache expires", async () => {
  const settings = decodeSettings({
    secretProviders: {
      vault: { kind: "one_password", label: "Vault", config: { account: "team" } },
    },
  });
  const reference = decodeReference({ provider: "vault", reference: "op://work/item/password" });
  const read = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
  let now = 0;
  const resolve = makeSecretResolver(read, () => now);
  expect(await resolve(settings.secretProviders, reference)).toBe("first");
  expect(await resolve(settings.secretProviders, reference)).toBe("first");
  now = 60_001;
  expect(await resolve(settings.secretProviders, reference)).toBe("second");
  expect(read).toHaveBeenCalledTimes(2);
});

it("coalesces identical reads and refuses more than eight concurrent provider processes", async () => {
  const settings = decodeSettings({
    secretProviders: {
      vault: { kind: "one_password", label: "Vault", config: { account: "team" } },
    },
  });
  const gate = Promise.withResolvers<string>();
  const read = vi.fn(() => gate.promise);
  const resolve = makeSecretResolver(read, () => 0);
  const ref = (index: number) =>
    decodeReference({ provider: "vault", reference: `op://work/item/field${index}` });
  const first = resolve(settings.secretProviders, ref(0));
  const duplicate = resolve(settings.secretProviders, ref(0));
  const others = Array.from({ length: 7 }, (_, index) =>
    resolve(settings.secretProviders, ref(index + 1)),
  );
  await expect(resolve(settings.secretProviders, ref(9))).rejects.toThrow(
    "Secret provider is busy",
  );
  expect(read).toHaveBeenCalledTimes(8);
  gate.resolve("fixture");
  expect(await Promise.all([first, duplicate, ...others])).toEqual(Array(9).fill("fixture"));
});
