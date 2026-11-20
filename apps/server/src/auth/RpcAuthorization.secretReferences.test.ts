import { AuthProvidersManageScope, AuthSettingsWriteScope, WS_METHODS } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { authorizeRpcCall, requiredScopesForRpcCall } from "./RpcAuthorization.ts";

const reference = { provider: "personal", reference: "op://vault/item/field" };
it.effect("requires provider management for request-selected EAS secret references", () =>
  Effect.gen(function* () {
    const payload = { accessTokenReference: reference };
    expect(requiredScopesForRpcCall(WS_METHODS.deviceEasAccount, payload)).toContain(
      AuthProvidersManageScope,
    );
    const error = yield* Effect.flip(
      authorizeRpcCall([AuthSettingsWriteScope], WS_METHODS.deviceEasAccount, payload),
    );
    expect(error.requiredPermission).toBe(AuthProvidersManageScope);
    yield* authorizeRpcCall(
      [AuthSettingsWriteScope, AuthProvidersManageScope],
      WS_METHODS.deviceEasAccount,
      payload,
    );
  }),
);

it("requires provider management when checking or answering with a secret reference", () => {
  expect(
    requiredScopesForRpcCall(WS_METHODS.serverCheckSecretSource, { source: reference }),
  ).toEqual([AuthSettingsWriteScope, AuthProvidersManageScope]);
  expect(
    requiredScopesForRpcCall(WS_METHODS.secretsAnswerRequest, {
      answer: { type: "reference", reference },
    }),
  ).toEqual(["orchestration:operate", AuthProvidersManageScope]);
});
