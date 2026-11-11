import {
  AuthProvidersManageScope,
  ProviderInstanceId,
  ServerSettings,
  requiredScopesForServerSettingsPatch,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

it("requires provider management to configure model APIs", () => {
  const id = ProviderInstanceId.make("api");
  expect(
    requiredScopesForServerSettingsPatch({
      textGenerators: {
        [id]: {
          kind: "openaiCompatible",
          baseUrl: "https://api.example/v1",
          apiKey: "fixture",
          enabled: true,
        },
      },
    }),
  ).toContain(AuthProvidersManageScope);
});

it("rejects credential-bearing or unbounded API endpoints", () => {
  const decode = Schema.decodeUnknownExit(ServerSettings);
  for (const baseUrl of [
    "https://user:pass@example.com/v1",
    "https://api.example/v1?key=secret",
    "file:///tmp/api",
  ]) {
    expect(
      decode({
        textGenerators: { api: { kind: "openaiCompatible", baseUrl, apiKey: "", enabled: true } },
      })._tag,
    ).toBe("Failure");
  }
  const apiKey = "x".repeat(8193);
  expect(
    decode({
      textGenerators: {
        api: { kind: "openaiCompatible", baseUrl: "https://api.example/v1", apiKey, enabled: true },
      },
    })._tag,
  ).toBe("Failure");
  const generators = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [
      `api-${index}`,
      {
        kind: "openaiCompatible",
        baseUrl: "https://api.example/v1",
        apiKey: "",
        enabled: true,
      },
    ]),
  );
  expect(decode({ textGenerators: generators })._tag).toBe("Failure");
});
