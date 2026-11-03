import { expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerSettings } from "@goat/contracts";
import { resolveHostSecrets } from "./sourceControlHostSecrets.ts";
import { HostCredentialSettings } from "@goat/source-control-core/shared/definition";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeHostCredentialSettings = Schema.decodeUnknownSync(HostCredentialSettings);

it("retains keyed token references alongside literal host tokens", () => {
  const reference = { provider: "vault", reference: "op://work/item/one" };
  expect(
    decodeHostCredentialSettings({
      tokens: { "github.com": reference, "other.example": "literal" },
    }).tokens,
  ).toEqual({ "github.com": reference, "other.example": "literal" });
});

it("resolves only the requested source control host and preserves literal credentials", async () => {
  const selected = { provider: "vault", reference: "op://work/item/one" };
  const other = { provider: "vault", reference: "op://work/item/two" };
  const settings = decodeSettings({
    sourceControlHosts: {
      github: { tokens: { "github.com": selected, "other.example": other } },
      gitcafe: { token: "literal" },
    },
  });
  const read = vi.fn().mockResolvedValue("selected-secret");
  const resolved = await resolveHostSecrets(settings, "github", "github.com", read);
  expect(resolved.sourceControlHosts.github?.tokens).toEqual({
    "github.com": "selected-secret",
    "other.example": "",
  });
  expect(
    ((settings.sourceControlHosts.github?.tokens ?? {}) as Record<string, unknown>)[
      "other.example"
    ],
  ).toEqual(other);
  expect(resolved.sourceControlHosts.gitcafe?.token).toBe("literal");
  expect(read).toHaveBeenCalledTimes(1);
});

it("fails when a selected reference cannot be read", async () => {
  const settings = decodeSettings({
    sourceControlHosts: {
      gitcafe: { token: { provider: "vault", reference: "op://work/item/token" } },
    },
  });
  await expect(
    resolveHostSecrets(settings, "gitcafe", undefined, () =>
      Promise.reject(new Error("secret output")),
    ),
  ).rejects.toThrow("Could not resolve source control credential");
});
