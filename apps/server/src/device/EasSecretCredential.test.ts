import { expect, it } from "@effect/vitest";
import { ServerSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeSecretResolver } from "../secrets/secretResolver.ts";
import { readEasToken } from "./EasSecretCredential.ts";

const decode = Schema.decodeSync(ServerSettings);

it.effect("does not fall back to a different Expo account when a referenced token fails", () =>
  Effect.gen(function* () {
    const settings = decode({
      secretProviders: {
        personal: { kind: "one_password", label: "Vault", config: { account: "my.1password.com" } },
      },
    });
    const hostSettings = decode({
      easDeviceHosts: [
        {
          kind: "eas",
          id: "cloud",
          label: "Cloud",
          accessTokenReference: { provider: "personal", reference: "op://vault/item/field" },
        },
      ],
    });
    const ref = hostSettings.easDeviceHosts[0]?.accessTokenReference;
    if (ref == null) return yield* Effect.die("missing test reference");
    const resolve = makeSecretResolver(async () => {
      throw new Error("private detail");
    });
    const result = yield* readEasToken(settings, "old-account-token", ref, resolve).pipe(
      Effect.flip,
    );
    expect(result.message).toBe("Could not read the Expo token from its secret provider.");
    expect(yield* readEasToken(settings, "literal-token", undefined, resolve)).toBe(
      "literal-token",
    );
  }),
);
