import * as Schema from "effect/Schema";
import { AuthAccessCreatePairingInput } from "./authAccessRpc.ts";
import { expect, it } from "vite-plus/test";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";

it("requires access write for pairing and client revocation RPCs", () => {
  for (const method of [
    "auth.access.createPairing",
    "auth.access.revokePairing",
    "auth.access.revokeClient",
  ]) {
    expect(clientRpcRequiredScopes(method, {}), method).toEqual(["access:write"]);
  }
});

const decodePairing = Schema.decodeUnknownSync(AuthAccessCreatePairingInput);
it("bounds pairing labels and delegated permissions", () => {
  expect(() => decodePairing({ label: "x".repeat(257), scopes: ["orchestration:read"] })).toThrow();
  expect(() =>
    decodePairing({ scopes: Array.from({ length: 100 }, () => "orchestration:read") }),
  ).toThrow();
});
