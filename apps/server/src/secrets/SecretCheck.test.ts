import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, SecretProviderId, type SecretReference } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretCheck from "./SecretCheck.ts";

const vault = SecretProviderId.make("vault");
const checked: SecretReference = { provider: vault, reference: "op://work/api/key" };
const other: SecretReference = { provider: vault, reference: "op://work/other/key" };
const secretVariable = (secret: SecretReference) => ({
  name: "API_KEY",
  value: "",
  sensitive: true,
  secret,
});

const harness = (read: (account: string, reference: string) => Promise<string>) => {
  const reloaded: Array<ProviderInstanceId | undefined> = [];
  const reloadedWith: Array<string | undefined> = [];
  const reads: string[] = [];
  const layer = Layer.effect(
    SecretCheck.SecretCheck,
    SecretCheck.make((account, reference) => {
      reads.push(reference);
      return read(account, reference);
    }),
  ).pipe(
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        reloadSecretsAndRefresh: (instanceId, checkedSecret) =>
          Effect.sync(() => {
            reloaded.push(instanceId);
            reloadedWith.push(checkedSecret?.value);
            return [];
          }),
      }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        secretProviders: {
          [vault]: { kind: "one_password", label: "Vault", config: { account: "team" } },
        },
        providerInstances: {
          [ProviderInstanceId.make("codex_work")]: {
            driver: "codex",
            environment: [secretVariable(checked)],
          },
          [ProviderInstanceId.make("codex_other")]: {
            driver: "codex",
            environment: [secretVariable(other)],
          },
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, reloaded, reloadedWith, reads };
};

it.effect("reads the reference on every check and reloads only the providers that use it", () =>
  Effect.gen(function* () {
    const { layer, reloaded, reloadedWith, reads } = harness(async () => "fresh-api-key");
    const results = yield* Effect.gen(function* () {
      const service = yield* SecretCheck.SecretCheck;
      return [yield* service.check(checked), yield* service.check(checked)];
    }).pipe(Effect.provide(layer));
    expect(results).toEqual([{ _tag: "Resolved" }, { _tag: "Resolved" }]);
    expect(JSON.stringify(results)).not.toContain("fresh-api-key");
    expect(reads).toEqual(["op://work/api/key", "op://work/api/key"]);
    expect(reloaded).toEqual([
      ProviderInstanceId.make("codex_work"),
      ProviderInstanceId.make("codex_work"),
    ]);
    // One read per Check: the reload gets that read's value instead of reading again.
    expect(reloadedWith).toEqual(["fresh-api-key", "fresh-api-key"]);
  }),
);

it.effect("reports an unreadable or empty secret and reloads nothing", () =>
  Effect.gen(function* () {
    for (const read of [() => Promise.reject(new Error("1Password is locked")), async () => "  "]) {
      const { layer, reloaded } = harness(read);
      const result = yield* SecretCheck.SecretCheck.pipe(
        Effect.flatMap((service) => service.check(checked)),
        Effect.provide(layer),
      );
      expect(result).toMatchObject({ _tag: "Failed" });
      expect(result._tag === "Failed" ? result.detail : "").toContain('"Vault"');
      expect(reloaded).toEqual([]);
    }
  }),
);

it.effect("refuses a reference to a secret provider that is not configured", () =>
  Effect.gen(function* () {
    const { layer, reads } = harness(async () => "unused");
    const result = yield* SecretCheck.SecretCheck.pipe(
      Effect.flatMap((service) =>
        service.check({ provider: SecretProviderId.make("missing"), reference: "op://a/b/c" }),
      ),
      Effect.provide(layer),
    );
    expect(result).toMatchObject({ _tag: "Failed" });
    expect(reads).toEqual([]);
  }),
);
