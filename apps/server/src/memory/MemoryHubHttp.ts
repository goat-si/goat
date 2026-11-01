import * as M from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as Service from "./MemoryService.ts";
import * as Auth from "./MemoryHubAuth.ts";
import * as Settings from "../serverSettings.ts";

export type HubFailure =
  | Service.MemoryServiceError
  | M.MemoryHubError
  | M.MemoryHubUnauthorizedError
  | M.MemoryHubForbiddenError;

// Interface-only seam while L2 is built in parallel. Its runtime key and signatures
// must match L2's implementation; application composition provides that single service.
export class MemoryHubService extends Context.Service<
  MemoryHubService,
  {
    readonly join: (
      input: M.MemoryHubJoinInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubJoinResult, HubFailure>;
    readonly push: (
      input: M.MemoryHubPushInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubPushResult, HubFailure>;
    readonly pull: (
      input: M.MemoryHubPullInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubPullResult, HubFailure>;
    readonly claim: (
      input: M.MemoryHubClaimInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryResolutionLease, HubFailure>;
    readonly renew: (
      input: M.MemoryHubRenewInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryResolutionLease, HubFailure>;
    readonly applyResolution: (
      input: M.MemoryHubApplyResolutionInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubReceipt, HubFailure>;
    readonly release: (
      input: M.MemoryHubReleaseInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubReleaseResult, HubFailure>;
    readonly requestSourceRead: (
      input: M.MemoryHubSourceReadRequestInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadRequestResult, HubFailure>;
    readonly collectSourceReads: (
      input: M.MemoryHubSourceReadCollectInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadCollectResult, HubFailure>;
    readonly respondSourceRead: (
      input: M.MemoryHubSourceReadRespondInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadRespondResult, HubFailure>;
    readonly resultSourceRead: (
      input: M.MemoryHubSourceReadResultInput,
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<M.MemoryHubSourceReadResultResult, HubFailure>;
  }
>()(
  // @effect-diagnostics-next-line deterministicKeys:off -- Same runtime key as the separately implemented L2 service.
  "goat/memory/MemoryHubService",
) {}

class InvalidEnvelope extends Schema.TaggedError<InvalidEnvelope>()("MemoryHubInvalidEnvelope", {
  status: Schema.Literals([400, 413]),
}) {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const headers = { "cache-control": "no-store", "content-type": "application/json" };
const failureResponse = (error: HubFailure | InvalidEnvelope) => {
  if (error._tag === "MemoryHubUnauthorizedError")
    return HttpServerResponse.jsonUnsafe({ _tag: error._tag }, { status: 401, headers });
  if (error._tag === "MemoryHubForbiddenError")
    return HttpServerResponse.jsonUnsafe({ _tag: error._tag }, { status: 403, headers });
  if (error._tag === "MemoryHubInvalidEnvelope")
    return HttpServerResponse.jsonUnsafe(
      { code: error.status === 413 ? "payload_too_large" : "invalid_output" },
      { status: error.status, headers },
    );
  if (error._tag === "MemoryAccessError")
    return failureResponse(new M.MemoryHubError({ code: error.code }));
  if (error._tag === "MemoryStorageError")
    return failureResponse(new M.MemoryHubError({ code: "storage_failed" }));
  if (error._tag === "MemoryStoreConflict")
    return failureResponse(new M.MemoryHubError({ code: error.code }));
  if (error._tag === "MemoryCapacityError")
    return failureResponse(new M.MemoryHubError({ code: "capacity_exceeded" }));
  const status =
    error.code === "hub_disabled"
      ? 503
      : error.code === "unsupported_protocol"
        ? 426
        : error.code === "payload_too_large"
          ? 413
          : error.code === "route_unavailable"
            ? 404
            : error.code === "storage_failed"
              ? 503
              : 409;
  return HttpServerResponse.jsonUnsafe(
    { _tag: "MemoryHubError", code: error.code },
    { status, headers },
  );
};

const route = <I, IE, O, OE>(
  path: `/${string}`,
  inputSchema: Schema.Codec<I, IE>,
  outputSchema: Schema.Codec<O, OE>,
  maxBytes: number,
  call: (
    service: MemoryHubService["Service"],
    principal: M.MemoryHubPrincipal,
    input: I,
  ) => Effect.Effect<O, HubFailure>,
) => {
  const decode = Schema.decodeUnknownEffect(inputSchema);
  const encode = Schema.encodeEffect(Schema.fromJsonString(outputSchema));
  return HttpRouter.add(
    "POST",
    path,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* Auth.MemoryHubAuth;
      const service = yield* MemoryHubService;
      const settings = yield* Settings.ServerSettingsService;
      const configured = yield* settings.getSettings.pipe(
        Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
      );
      if (configured.memoryHub.mode !== "hub")
        return yield* new M.MemoryHubError({ code: "hub_disabled" });
      const principal = yield* auth.authenticate(request.headers.authorization);
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json"))
        return yield* new InvalidEnvelope({ status: 400 });
      let size = 0;
      const chunks = yield* request.stream.pipe(
        Stream.mapError(() => new InvalidEnvelope({ status: 400 })),
        Stream.mapEffect((chunk) => {
          size += chunk.length;
          return size > maxBytes
            ? Effect.fail(new InvalidEnvelope({ status: 413 }))
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
        catch: () => new InvalidEnvelope({ status: 400 }),
      });
      const raw = yield* decodeJson(text).pipe(
        Effect.mapError(() => new InvalidEnvelope({ status: 400 })),
      );
      if (
        raw !== null &&
        typeof raw === "object" &&
        "protocolVersion" in raw &&
        raw.protocolVersion !== 1
      )
        return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
      const input = yield* decode(raw).pipe(
        Effect.mapError(() => new InvalidEnvelope({ status: 400 })),
      );
      const result = yield* call(service, principal, input);
      const body = yield* encode(result).pipe(
        Effect.mapError(() => new M.MemoryHubError({ code: "invalid_output" })),
      );
      return HttpServerResponse.text(body, { headers });
    }).pipe(Effect.catch((error) => Effect.succeed(failureResponse(error)))),
  );
};

/** Available only after all hub routes and their dependencies have been acquired. */
export class MemoryHubHttpReady extends Context.Service<
  MemoryHubHttpReady,
  { readonly protocolVersion: typeof M.MEMORY_PROTOCOL_VERSION }
>()("goat/memory/MemoryHubHttp/MemoryHubHttpReady") {}

const routes = Layer.mergeAll(
  route(M.MEMORY_HUB_PATHS.join, M.MemoryHubJoinInput, M.MemoryHubJoinResult, 65536, (s, p, i) =>
    s.join(i, p),
  ),
  route(M.MEMORY_HUB_PATHS.push, M.MemoryHubPushInput, M.MemoryHubPushResult, 1048576, (s, p, i) =>
    s.push(i, p),
  ),
  route(M.MEMORY_HUB_PATHS.pull, M.MemoryHubPullInput, M.MemoryHubPullResult, 65536, (s, p, i) =>
    s.pull(i, p),
  ),
  route(
    M.MEMORY_HUB_PATHS.claim,
    M.MemoryHubClaimInput,
    M.MemoryResolutionLease,
    65536,
    (s, p, i) => s.claim(i, p),
  ),
  route(
    M.MEMORY_HUB_PATHS.renew,
    M.MemoryHubRenewInput,
    M.MemoryResolutionLease,
    65536,
    (s, p, i) => s.renew(i, p),
  ),
  route(
    M.MEMORY_HUB_PATHS.applyResolution,
    M.MemoryHubApplyResolutionInput,
    M.MemoryHubReceipt,
    256 * 1024 + M.MEMORY_PAGE_MAX_UTF8_BYTES,
    (s, p, i) => s.applyResolution(i, p),
  ),
  route(
    M.MEMORY_HUB_PATHS.release,
    M.MemoryHubReleaseInput,
    M.MemoryHubReleaseResult,
    65536,
    (s, p, i) => s.release(i, p),
  ),
  route(
    M.MEMORY_HUB_PATHS.sourceReadRequest,
    M.MemoryHubSourceReadRequestInput,
    M.MemoryHubSourceReadRequestResult,
    65536,
    (s, p, i) => s.requestSourceRead(i, p),
  ),
  route(
    M.MEMORY_HUB_PATHS.sourceReadCollect,
    M.MemoryHubSourceReadCollectInput,
    M.MemoryHubSourceReadCollectResult,
    65536,
    (s, p, i) => s.collectSourceReads(i, p),
  ),
  route(
    M.MEMORY_HUB_PATHS.sourceReadRespond,
    M.MemoryHubSourceReadRespondInput,
    M.MemoryHubSourceReadRespondResult,
    131072,
    (s, p, i) => s.respondSourceRead(i, p),
  ),
  route(
    M.MEMORY_HUB_PATHS.sourceReadResult,
    M.MemoryHubSourceReadResultInput,
    M.MemoryHubSourceReadResultResult,
    65536,
    (s, p, i) => s.resultSourceRead(i, p),
  ),
);

export const layer = Layer.effect(
  MemoryHubHttpReady,
  Effect.gen(function* () {
    yield* Auth.MemoryHubAuth;
    yield* MemoryHubService;
    yield* Settings.ServerSettingsService;
    return MemoryHubHttpReady.of({ protocolVersion: M.MEMORY_PROTOCOL_VERSION });
  }),
).pipe(Layer.provideMerge(routes));
