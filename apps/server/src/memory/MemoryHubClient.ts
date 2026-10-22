import * as M from "@goat/contracts";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Secrets from "../auth/ServerSecretStore.ts";
import { memoryOperationDigest } from "./MemoryDecider.ts";
import { sourceReadInput, sourceReadLocatorDigest } from "./MemoryOwnerSourceReader.ts";
import * as Settings from "../serverSettings.ts";

export type HubConnection = Extract<M.MemoryHubSettings, { mode: "member" }> & {
  readonly epoch: number;
};
export type HubClientFailure =
  | M.MemoryHubError
  | M.MemoryHubUnauthorizedError
  | M.MemoryHubForbiddenError;
/**
 * Whether settings still bind this connection. When they do not, the client fences a request
 * locally without reaching the Hub.
 */
export const isCurrentConnection = (
  current: Pick<M.ServerSettings, "memoryHub" | "memoryHubVersion">,
  connection: HubConnection,
) => {
  const configured = current.memoryHub;
  return (
    configured.mode === "member" &&
    current.memoryHubVersion === connection.epoch &&
    configured.endpoint === connection.endpoint &&
    configured.hubEnvironmentId === connection.hubEnvironmentId &&
    configured.secretName === connection.secretName &&
    configured.memorySpaceId === connection.memorySpaceId
  );
};
const REQUEST_TIMEOUT_MS = 15000;
const RESPONSE_MAX_BYTES = 1048576;
const retrySchedule = Schedule.exponential("250 millis").pipe(Schedule.upTo({ times: 2 }));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEndpoint = Schema.decodeUnknownEffect(M.MemoryHubEndpoint);
const decodeDescriptor = Schema.decodeUnknownEffect(M.ExecutionEnvironmentDescriptor);
const decodeDomainError = Schema.decodeUnknownEffect(M.MemoryHubError);

export class MemoryHubClient extends Context.Service<
  MemoryHubClient,
  {
    readonly preflight: (
      connection: HubConnection,
    ) => Effect.Effect<M.ExecutionEnvironmentDescriptor, HubClientFailure>;
    readonly join: (
      connection: HubConnection,
      input: M.MemoryHubJoinInput,
    ) => Effect.Effect<M.MemoryHubJoinResult, HubClientFailure>;
    readonly push: (
      connection: HubConnection,
      input: M.MemoryHubPushInput,
    ) => Effect.Effect<M.MemoryHubPushResult, HubClientFailure>;
    readonly pull: (
      connection: HubConnection,
      input: M.MemoryHubPullInput,
    ) => Effect.Effect<M.MemoryHubPullResult, HubClientFailure>;
    readonly claim: (
      connection: HubConnection,
      input: M.MemoryHubClaimInput,
    ) => Effect.Effect<M.MemoryResolutionLease, HubClientFailure>;
    readonly renew: (
      connection: HubConnection,
      input: M.MemoryHubRenewInput,
    ) => Effect.Effect<M.MemoryResolutionLease, HubClientFailure>;
    readonly applyResolution: (
      connection: HubConnection,
      input: M.MemoryHubApplyResolutionInput,
    ) => Effect.Effect<M.MemoryHubReceipt, HubClientFailure>;
    readonly release: (
      connection: HubConnection,
      input: M.MemoryHubReleaseInput,
    ) => Effect.Effect<M.MemoryHubReleaseResult, HubClientFailure>;
    readonly requestSourceRead: (
      connection: HubConnection,
      input: M.MemoryHubSourceReadRequestInput,
    ) => Effect.Effect<M.MemoryHubSourceReadRequestResult, HubClientFailure>;
    readonly collectSourceReads: (
      connection: HubConnection,
      input: M.MemoryHubSourceReadCollectInput,
    ) => Effect.Effect<M.MemoryHubSourceReadCollectResult, HubClientFailure>;
    readonly respondSourceRead: (
      connection: HubConnection,
      input: M.MemoryHubSourceReadRespondInput,
      prepare?: Effect.Effect<M.MemoryHubSourceReadRespondInput, HubClientFailure>,
    ) => Effect.Effect<M.MemoryHubSourceReadRespondResult, HubClientFailure>;
    readonly resultSourceRead: (
      connection: HubConnection,
      input: M.MemoryHubSourceReadResultInput,
    ) => Effect.Effect<M.MemoryHubSourceReadResultResult, HubClientFailure>;
  }
>()("goat/memory/MemoryHubClient") {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* Secrets.ServerSecretStore;
  const settings = yield* Settings.ServerSettingsService;

  const ensureEpoch = Effect.fnUntraced(function* (connection: HubConnection) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
    );
    if (!isCurrentConnection(current, connection)) {
      return yield* new M.MemoryHubError({ code: "fenced" });
    }
  });

  const readJson = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
    const declared = response.headers["content-length"];
    if (
      declared !== undefined &&
      (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_MAX_BYTES)
    )
      return yield* new M.MemoryHubError({ code: "payload_too_large" });
    let size = 0;
    const chunks = yield* response.stream.pipe(
      Stream.mapError(() => new M.MemoryHubError({ code: "unavailable" })),
      Stream.mapEffect((chunk) => {
        size += chunk.length;
        return size > RESPONSE_MAX_BYTES
          ? Effect.fail(new M.MemoryHubError({ code: "payload_too_large" }))
          : Effect.succeed(chunk);
      }),
      Stream.runCollect,
    );
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => new M.MemoryHubError({ code: "invalid_output" }),
    });
    return yield* decodeJson(text).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
    );
  });

  const checkResponse = Effect.fnUntraced(function* (
    response: HttpClientResponse.HttpClientResponse,
  ) {
    if (response.status >= 300 && response.status < 400)
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    if (response.status === 401) return yield* new M.MemoryHubUnauthorizedError({});
    if (response.status === 403) return yield* new M.MemoryHubForbiddenError({});
    if (response.status === 404 || response.status === 405)
      return yield* new M.MemoryHubError({ code: "route_unavailable" });
    if (response.status === 426)
      return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
    if (response.status === 413) return yield* new M.MemoryHubError({ code: "payload_too_large" });
    if (response.status === 429 || response.status >= 500) {
      const parsed = yield* Effect.result(
        readJson(response).pipe(Effect.flatMap(decodeDomainError)),
      );
      if (parsed._tag === "Success") return yield* parsed.success;
      return yield* new M.MemoryHubError({ code: "unavailable" });
    }
    const raw = yield* readJson(response);
    if (response.status < 200 || response.status >= 300) {
      const error = yield* decodeDomainError(raw).pipe(
        Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
      );
      return yield* error;
    }
    return raw;
  });

  // This service owns a fetch-backed transport with redirects and cookies disabled.
  // The caller cannot replace it with a cookie-preferred environment client.
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
      }),
      Effect.mapError(() => new M.MemoryHubError({ code: "unavailable" })),
      Effect.flatMap(checkResponse),
    );

  const preflightOnce = Effect.fnUntraced(function* (connection: HubConnection) {
    yield* ensureEpoch(connection);
    const endpoint = yield* decodeEndpoint(connection.endpoint).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "identity_mismatch" })),
    );
    const raw = yield* execute(
      HttpClientRequest.get(new URL(GOAT_ENVIRONMENT_PATH, endpoint).href),
    );
    const descriptor = yield* decodeDescriptor(raw).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
    );
    if (descriptor.environmentId !== connection.hubEnvironmentId)
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    if (descriptor.capabilities.memoryHubProtocolVersion !== 1)
      return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
    yield* ensureEpoch(connection);
    return descriptor;
  });

  const bounded = <A>(effect: Effect.Effect<A, HubClientFailure>) =>
    effect.pipe(
      Effect.retry({
        schedule: retrySchedule,
        while: (error) => error._tag === "MemoryHubError" && error.code === "unavailable",
      }),
      Effect.timeout(REQUEST_TIMEOUT_MS),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(new M.MemoryHubError({ code: "unavailable" })),
      }),
    );

  const call = <I, IE, O, OE>(
    path: string,
    inputSchema: Schema.Codec<I, IE>,
    outputSchema: Schema.Codec<O, OE>,
    validate: (connection: HubConnection, input: I, output: O) => boolean = () => true,
  ) => {
    const encode = Schema.encodeEffect(Schema.fromJsonString(inputSchema));
    const decode = Schema.decodeUnknownEffect(outputSchema);
    return (connection: HubConnection, input: I, prepare?: Effect.Effect<I, HubClientFailure>) =>
      bounded(
        Effect.gen(function* () {
          yield* preflightOnce(connection);
          const credential = yield* secrets
            .get(connection.secretName)
            .pipe(Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })));
          if (Option.isNone(credential)) return yield* new M.MemoryHubUnauthorizedError({});
          const token = new TextDecoder().decode(credential.value);
          if (!/^[A-Za-z0-9_-]{43}$/.test(token))
            return yield* new M.MemoryHubUnauthorizedError({});
          yield* ensureEpoch(connection);
          // Descriptor/credential waits are complete. Revalidate source for each attempt.
          const prepared = prepare ? yield* prepare : input;
          const body = yield* encode(prepared).pipe(
            Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
          );
          if (new TextEncoder().encode(body).length > RESPONSE_MAX_BYTES)
            return yield* new M.MemoryHubError({ code: "payload_too_large" });
          const raw = yield* execute(
            HttpClientRequest.post(new URL(path, connection.endpoint).href).pipe(
              HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
              HttpClientRequest.bodyText(body, "application/json"),
            ),
          );
          const output = yield* decode(raw).pipe(
            Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
          );
          yield* ensureEpoch(connection);
          if (!validate(connection, input, output))
            return yield* new M.MemoryHubError({ code: "invalid_output" });
          return output;
        }),
      );
  };

  return MemoryHubClient.of({
    preflight: (connection) => bounded(preflightOnce(connection)),
    join: call(
      M.MEMORY_HUB_PATHS.join,
      M.MemoryHubJoinInput,
      M.MemoryHubJoinResult,
      (c, _i, o) =>
        o.hubEnvironmentId === c.hubEnvironmentId &&
        (c.memorySpaceId === null || o.memorySpaceId === c.memorySpaceId),
    ),
    push: call(
      M.MEMORY_HUB_PATHS.push,
      M.MemoryHubPushInput,
      M.MemoryHubPushResult,
      (_c, i, o) =>
        o.receipts.length === i.operations.length &&
        o.receipts.every((r, index) => {
          const operation = i.operations[index];
          return (
            operation !== undefined &&
            r.operationId === operation.operationId &&
            r.operationDigest === memoryOperationDigest(operation)
          );
        }),
    ),
    pull: call(
      M.MEMORY_HUB_PATHS.pull,
      M.MemoryHubPullInput,
      M.MemoryHubPullResult,
      (_c, i, o) =>
        (i.highWatermark === undefined || i.highWatermark === o.highWatermark) &&
        (o.checkpoint === undefined || o.checkpoint.memorySpaceId === i.memorySpaceId),
    ),
    claim: call(M.MEMORY_HUB_PATHS.claim, M.MemoryHubClaimInput, M.MemoryResolutionLease),
    renew: call(M.MEMORY_HUB_PATHS.renew, M.MemoryHubRenewInput, M.MemoryResolutionLease),
    applyResolution: call(
      M.MEMORY_HUB_PATHS.applyResolution,
      M.MemoryHubApplyResolutionInput,
      M.MemoryHubReceipt,
      (_c, i, o) =>
        o.operationId === i.operation.operationId &&
        o.operationDigest === memoryOperationDigest(i.operation),
    ),
    release: call(M.MEMORY_HUB_PATHS.release, M.MemoryHubReleaseInput, M.MemoryHubReleaseResult),
    requestSourceRead: call(
      M.MEMORY_HUB_PATHS.sourceReadRequest,
      M.MemoryHubSourceReadRequestInput,
      M.MemoryHubSourceReadRequestResult,
      (_connection, input, output) =>
        output.request.requestId === input.requestId &&
        output.request.memorySpaceId === input.memorySpaceId &&
        output.request.stamp !== undefined &&
        output.request.stamp.locatorDigest === sourceReadLocatorDigest(input) &&
        sourceReadLocatorDigest(sourceReadInput(output.request)) === sourceReadLocatorDigest(input),
    ),
    collectSourceReads: call(
      M.MEMORY_HUB_PATHS.sourceReadCollect,
      M.MemoryHubSourceReadCollectInput,
      M.MemoryHubSourceReadCollectResult,
    ),
    respondSourceRead: call(
      M.MEMORY_HUB_PATHS.sourceReadRespond,
      M.MemoryHubSourceReadRespondInput,
      M.MemoryHubSourceReadRespondResult,
      (_connection, input, output) =>
        input.kind === "revoke"
          ? output.kind === "revoke" &&
            output.ack.memorySpaceId === input.memorySpaceId &&
            output.ack.requesterEnvironmentId === input.requesterEnvironmentId &&
            output.ack.removalEpoch === input.ownerPolicyEpoch &&
            output.ack.revokedThroughEpoch >= input.ownerPolicyEpoch
          : output.kind === "normal",
    ),
    resultSourceRead: call(
      M.MEMORY_HUB_PATHS.sourceReadResult,
      M.MemoryHubSourceReadResultInput,
      M.MemoryHubSourceReadResultResult,
    ),
  });
});

export const layer = Layer.effect(MemoryHubClient, make).pipe(Layer.provide(FetchHttpClient.layer));
