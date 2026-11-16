import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { SecretReference, SecretSourceCheckResult } from "./secretReference.ts";
import { OtlpEndpointCheckInput, OtlpEndpointCheckResult } from "./server.ts";

/** Settings checks that read an external endpoint or store on demand and report what they found. */
export const SERVER_CHECK_WS_METHODS = {
  serverCheckOtlpEndpoint: "server.checkOtlpEndpoint",
  serverCheckSecretSource: "server.checkSecretSource",
} as const;

export const WsServerCheckOtlpEndpointRpc = Rpc.make(
  SERVER_CHECK_WS_METHODS.serverCheckOtlpEndpoint,
  {
    payload: OtlpEndpointCheckInput,
    success: OtlpEndpointCheckResult,
    error: EnvironmentAuthorizationError,
  },
);

/** Reads one secret reference now; the result never carries the value. */
export const WsServerCheckSecretSourceRpc = Rpc.make(
  SERVER_CHECK_WS_METHODS.serverCheckSecretSource,
  {
    payload: Schema.Struct({ source: SecretReference }),
    success: SecretSourceCheckResult,
    error: EnvironmentAuthorizationError,
  },
);
