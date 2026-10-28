import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

export const PUBLIC_PROBE_INTERVAL_MS = 10 * 60_000;
const ProbeIdentity = Schema.Struct({ environmentId: Schema.String });
export const probePublicEndpoint = Effect.fn("ManagedEndpointProbe.probe")(
  function* (input: { readonly hostname: string; readonly environmentId: string }) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get(`https://${input.hostname}/.well-known/t3/environment`);
    if (response.status !== 200) return false;
    const identity = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ProbeIdentity)),
    );
    return identity.environmentId === input.environmentId;
  },
  Effect.scoped,
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => false),
);

export function nextProbeFailures(previous: number, healthy: boolean): number {
  return healthy ? 0 : previous + 1;
}
