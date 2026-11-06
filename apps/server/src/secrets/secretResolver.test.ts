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

it("keeps a successful read across background calls until explicit invalidation", async () => {
  const settings = decodeSettings({
    secretProviders: {
      vault: { kind: "one_password", label: "Vault", config: { account: "team" } },
    },
  });
  const reference = decodeReference({ provider: "vault", reference: "op://work/item/password" });
  const read = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
  using clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const resolve = makeSecretResolver(read);
  expect(await resolve(settings.secretProviders, reference)).toBe("first");
  clock.mockReturnValue(120_000);
  expect(await resolve(settings.secretProviders, reference)).toBe("first");
  expect(await resolve(settings.secretProviders, reference)).toBe("first");
  expect(read).toHaveBeenCalledTimes(1);
  resolve.invalidate();
  expect(await resolve(settings.secretProviders, reference)).toBe("second");
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps a failed read until explicit invalidation without exposing the original error", async () => {
  const settings = decodeSettings({
    secretProviders: {
      vault: { kind: "one_password", label: "Vault", config: { account: "team" } },
    },
  });
  const reference = decodeReference({ provider: "vault", reference: "op://work/item/password" });
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("secret in failure"))
    .mockResolvedValueOnce("unlocked");
  const resolve = makeSecretResolver(read);
  await expect(resolve(settings.secretProviders, reference)).rejects.toThrow(
    "Could not read secret",
  );
  await expect(resolve(settings.secretProviders, reference)).rejects.toThrow(
    "Could not read secret",
  );
  expect(read).toHaveBeenCalledTimes(1);
  resolve.invalidate();
  await expect(resolve(settings.secretProviders, reference)).resolves.toBe("unlocked");
  expect(read).toHaveBeenCalledTimes(2);
});

it("uses the provider account as part of the cache key", async () => {
  const providers = (account: string) =>
    decodeSettings({
      secretProviders: { vault: { kind: "one_password", label: "Vault", config: { account } } },
    }).secretProviders;
  const reference = decodeReference({ provider: "vault", reference: "op://work/item/password" });
  const read = vi.fn(async (account: string) => account);
  const resolve = makeSecretResolver(read);
  expect(await resolve(providers("first"), reference)).toBe("first");
  expect(await resolve(providers("second"), reference)).toBe("second");
  expect(await resolve(providers("first"), reference)).toBe("first");
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
  const resolve = makeSecretResolver(read);
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

it("fails closed at capacity without evicting earlier reads", async () => {
  const settings = decodeSettings({
    secretProviders: {
      vault: { kind: "one_password", label: "Vault", config: { account: "team" } },
    },
  });
  const read = vi.fn().mockResolvedValue("fixture");
  const resolve = makeSecretResolver(read);
  const ref = (index: number) =>
    decodeReference({ provider: "vault", reference: `op://work/item/field${index}` });
  for (let index = 0; index < 128; index++) await resolve(settings.secretProviders, ref(index));
  await expect(resolve(settings.secretProviders, ref(128))).rejects.toThrow(
    "Secret provider cache is full",
  );
  expect(await resolve(settings.secretProviders, ref(0))).toBe("fixture");
  expect(read).toHaveBeenCalledTimes(128);
});

it("queues uncached reads after eight and releases a permit on failure", async () => {
  const { withSecretReadAdmission } = await import("./secretResolver.ts");
  const gates = Array.from({ length: 9 }, () => Promise.withResolvers<string>());
  let started = 0;
  const reads = gates.map((gate) =>
    withSecretReadAdmission(() => {
      started++;
      return gate.promise;
    }),
  );
  expect(started).toBe(8);
  gates[0]!.reject(new Error("locked"));
  await expect(reads[0]).rejects.toThrow("locked");
  expect(started).toBe(9);
  for (const gate of gates.slice(1)) gate.resolve("fresh");
  expect(await Promise.all(reads.slice(1))).toEqual(Array(8).fill("fresh"));
});

it("removes a cancelled queued read without starting it", async () => {
  const { withSecretReadAdmission } = await import("./secretResolver.ts");
  const gate = Promise.withResolvers<string>();
  const reads = Array.from({ length: 8 }, () => withSecretReadAdmission(() => gate.promise));
  const controller = new AbortController();
  const read = vi.fn(async () => "should not run");
  const queued = withSecretReadAdmission(read, controller.signal);
  controller.abort();
  await expect(queued).rejects.toThrow("cancelled");
  gate.resolve("done");
  await Promise.all(reads);
  expect(read).not.toHaveBeenCalled();
});
