import {
  BoatSandboxId,
  CloudMachineError,
  CloudMachineState,
  type CloudMachineType,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * The few Boat REST calls GOAT needs (https://docs.boat.dev/api/v1). The API key is passed per
 * call and only ever lands in the Authorization header; tracing is off for these requests and no
 * response body or header is logged, so neither the key nor a raw Boat error leaves this module.
 */

const BOAT_API_BASE = "https://boat.dev/api/v1";
const REQUEST_TIMEOUT = "20 seconds";

export interface BoatSandbox {
  readonly id: BoatSandboxId;
  readonly name: string | null;
  readonly state: CloudMachineState;
}

export interface BoatSshEndpoint {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** `<type> <base64>`, ready for a known_hosts line. */
  readonly hostKey: string;
}

export class BoatClient extends Context.Service<
  BoatClient,
  {
    /** Proves the key works and can read sandboxes; reads nothing from the response. */
    readonly checkKey: (apiKey: string) => Effect.Effect<void, CloudMachineError>;
    readonly get: (
      apiKey: string,
      id: BoatSandboxId,
    ) => Effect.Effect<BoatSandbox, CloudMachineError>;
    /** Retries a lost or in-flight request with the same Idempotency-Key, so Boat creates one machine. */
    readonly create: (
      apiKey: string,
      input: { readonly type: CloudMachineType; readonly ttlSeconds: number },
      idempotencyKey: string,
    ) => Effect.Effect<BoatSandbox, CloudMachineError>;
    readonly update: (
      apiKey: string,
      id: BoatSandboxId,
      patch: { readonly name?: string; readonly ttlSeconds?: number },
    ) => Effect.Effect<void, CloudMachineError>;
    readonly stop: (apiKey: string, id: BoatSandboxId) => Effect.Effect<void, CloudMachineError>;
    readonly resume: (apiKey: string, id: BoatSandboxId) => Effect.Effect<void, CloudMachineError>;
    /** Irreversible. Boat accepts it and deletes in the background. */
    readonly remove: (apiKey: string, id: BoatSandboxId) => Effect.Effect<void, CloudMachineError>;
    readonly authorizeSshKey: (
      apiKey: string,
      id: BoatSandboxId,
      publicKey: string,
    ) => Effect.Effect<BoatSshEndpoint, CloudMachineError>;
  }
>()("goat/cloudMachines/BoatClient") {}

const ApiError = Schema.Struct({ code: Schema.optional(Schema.String) });
const decodeApiError = Schema.decodeUnknownOption(ApiError);
const Sandbox = Schema.Struct({
  id: BoatSandboxId,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: CloudMachineState,
});
const SandboxEnvelope = Schema.Struct({ ok: Schema.Literal(true), sandbox: Sandbox });
const SshKeyEnvelope = Schema.Struct({
  ok: Schema.Literal(true),
  machineIp: Schema.optional(Schema.NullOr(Schema.String)),
  sshEndpoint: Schema.optional(Schema.NullOr(Schema.String)),
  sshUser: Schema.optional(Schema.String),
  hostKey: Schema.optional(Schema.String),
});

const fail = (reason: CloudMachineError["reason"]) => new CloudMachineError({ reason });

/** Maps an HTTP failure to a safe reason; the body is read only for Boat's error code. */
function boatErrorReason(status: number, body: unknown): CloudMachineError["reason"] {
  const code = Option.match(decodeApiError(body), {
    onNone: () => "",
    onSome: (value) => value.code ?? "",
  });
  if (status === 401) return "invalid_key";
  if (status === 402) return "billing_required";
  if (status === 403) return "scope_denied";
  if (status === 404) return "not_found";
  if (status === 409 && code === "snapshot_data_expired") return "snapshot_expired";
  if (status === 409) return "conflict";
  if (status === 429) return "limit_reached";
  if (status >= 500) return "transport_error";
  return "protocol_error";
}

const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_KEY_PATTERN =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?: [^\r\n]*)?$/;

const parsePort = (value: string): number | null => {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
};

/**
 * Boat returns `sshEndpoint` (`host:port`) when the machine has no public IPv4 of its own, else
 * `machineIp` on port 22. A missing or malformed host key fails: GOAT never connects unpinned.
 */
export function parseBoatSshEndpoint(value: typeof SshKeyEnvelope.Type): BoatSshEndpoint | null {
  const hostKeyMatch = HOST_KEY_PATTERN.exec(value.hostKey?.trim() ?? "");
  if (hostKeyMatch === null) return null;
  const user = value.sshUser?.trim() || "user";
  if (!USER_PATTERN.test(user)) return null;
  const endpoint = value.sshEndpoint?.trim();
  let host: string | undefined;
  let port: number | null = 22;
  if (endpoint) {
    const separator = endpoint.lastIndexOf(":");
    if (separator <= 0) return null;
    host = endpoint.slice(0, separator);
    port = parsePort(endpoint.slice(separator + 1));
  } else {
    host = value.machineIp?.trim();
  }
  if (host === undefined || !HOST_PATTERN.test(host) || port === null) return null;
  return { host, port, user, hostKey: `${hostKeyMatch[1]} ${hostKeyMatch[2]}` };
}

const toSandbox = (sandbox: typeof Sandbox.Type): BoatSandbox => ({
  id: sandbox.id,
  name: sandbox.name ?? null,
  state: sandbox.state,
});

export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;

  const readBody = (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(Effect.orElseSucceed((): unknown => undefined));

  const send = (apiKey: string, request: HttpClientRequest.HttpClientRequest) =>
    http
      .execute(
        request.pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
          HttpClientRequest.setHeader("Accept", "application/json"),
        ),
      )
      .pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
        }),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(() => fail("transport_error")),
        Effect.flatMap((response) =>
          readBody(response).pipe(
            Effect.flatMap((body) =>
              response.status >= 200 && response.status < 300
                ? Effect.succeed(body)
                : Effect.fail(fail(boatErrorReason(response.status, body))),
            ),
          ),
        ),
      );

  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => {
    const decoder = Schema.decodeUnknownEffect(schema);
    return (body: unknown) => decoder(body).pipe(Effect.mapError(() => fail("protocol_error")));
  };
  const decodeSandbox = decode(SandboxEnvelope);
  const decodeSshKey = decode(SshKeyEnvelope);

  const url = (path: string) => `${BOAT_API_BASE}${path}`;
  const sandboxPath = (id: BoatSandboxId) => `/sandboxes/${encodeURIComponent(id)}`;

  return BoatClient.of({
    checkKey: (apiKey) =>
      send(apiKey, HttpClientRequest.get(url("/sandboxes?limit=1"))).pipe(Effect.asVoid),
    get: (apiKey, id) =>
      send(apiKey, HttpClientRequest.get(url(sandboxPath(id)))).pipe(
        Effect.flatMap(decodeSandbox),
        Effect.map((body) => toSandbox(body.sandbox)),
      ),
    create: (apiKey, input, idempotencyKey) =>
      send(
        apiKey,
        HttpClientRequest.post(url("/sandboxes")).pipe(
          HttpClientRequest.setHeader("Idempotency-Key", idempotencyKey),
          HttpClientRequest.bodyJsonUnsafe({
            type: input.type,
            ttlSeconds: input.ttlSeconds,
            // The machine gets none of the account's secrets; GOAT brings its own credentials.
            noEnv: true,
          }),
        ),
      ).pipe(
        // A lost response or a request Boat is still processing is retried with the same key.
        Effect.retry({
          while: (error) => error.reason === "transport_error" || error.reason === "conflict",
          schedule: Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 3 })),
        }),
        Effect.flatMap(decodeSandbox),
        Effect.map((body) => toSandbox(body.sandbox)),
      ),
    update: (apiKey, id, patch) =>
      send(
        apiKey,
        HttpClientRequest.patch(url(sandboxPath(id))).pipe(HttpClientRequest.bodyJsonUnsafe(patch)),
      ).pipe(Effect.asVoid),
    stop: (apiKey, id) =>
      send(apiKey, HttpClientRequest.post(url(`${sandboxPath(id)}/stop`))).pipe(Effect.asVoid),
    resume: (apiKey, id) =>
      send(apiKey, HttpClientRequest.post(url(`${sandboxPath(id)}/resume`))).pipe(Effect.asVoid),
    remove: (apiKey, id) =>
      send(
        apiKey,
        HttpClientRequest.delete(url(sandboxPath(id))).pipe(
          HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", id),
        ),
      ).pipe(Effect.asVoid),
    authorizeSshKey: (apiKey, id, publicKey) =>
      send(
        apiKey,
        HttpClientRequest.post(url(`${sandboxPath(id)}/sshkey`)).pipe(
          HttpClientRequest.bodyJsonUnsafe({ key: publicKey }),
        ),
      ).pipe(
        Effect.flatMap(decodeSshKey),
        Effect.map(parseBoatSshEndpoint),
        Effect.filterOrFail(
          (endpoint): endpoint is BoatSshEndpoint => endpoint !== null,
          () => fail("protocol_error"),
        ),
      ),
  });
});

export const layer = Layer.effect(BoatClient, make);
