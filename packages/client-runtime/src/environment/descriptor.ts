import { GOAT_ENVIRONMENT_PATH, LEGACY_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import type { ExecutionEnvironmentDescriptor } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

/** SSH discovery metadata; revalidate before sending credentials because a forward can be replaced. */
export interface VerifiedSshEndpoint {
  readonly httpBaseUrl: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "metadata");
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, GOAT_ENVIRONMENT_PATH),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.descriptor(),
  ).pipe(
    Effect.catchTags({
      RemoteEnvironmentAuthUndeclaredStatusError: (error) =>
        error.status === 404
          ? executeEnvironmentHttpRequest(
              environmentEndpointUrl(input.httpBaseUrl, LEGACY_ENVIRONMENT_PATH),
              input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
              client.legacyDescriptor(),
            )
          : Effect.fail(error),
    }),
  );
});
