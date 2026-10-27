import { type ConnectLinkIntent } from "@goat/contracts/connectAssurance";
import {
  createCliApprovalKey,
  acceptsCliApprovalPost,
  decodeCliApprovalCallback,
  type ApprovedCliLink,
} from "./CliLinkApproval.ts";
// @effect-diagnostics nodeBuiltinImport:off - The CLI loopback OAuth callback is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Terminal from "effect/Terminal";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { buildConnectAuthorizeRequestUrl } from "@goat/shared/connectAuth";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import {
  cloudCliOAuthConfig,
  hostedAppUrlConfig,
  type CloudCliOAuthConfig,
} from "./publicConfig.ts";
import { renderLoopbackAuthorizationCompleteHtml } from "./cliAuthHtml.ts";

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const CLOUD_CLI_OAUTH_TOKEN_SECRET = "cloud-cli-oauth-token";
const CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT = Duration.minutes(10);
const CLOUD_CLI_OAUTH_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));
// A stalled OAuth request holds the semaphore and blocks all credential calls.
const OAUTH_REQUEST_TIMEOUT = Duration.seconds(10);
const boldTerminalText = (value: string): string => `\u001b[1m${value}\u001b[22m`;

function formatLoopbackAuthorizationPrompt(authorizationUrl: string): string {
  return [
    "Open this URL to authorize GOAT Connect:",
    `  ${authorizationUrl}`,
    "",
    `Press ${boldTerminalText("Enter")} to open it in your browser.`,
    "A local browser and MFA are required for the Connect beta.",
  ].join("\n");
}

export type LoopbackAuthorizationResult =
  | { readonly _tag: "AuthorizationCode"; readonly code: string }
  | { readonly _tag: "HeadlessRequested" };

const readLoopbackAuthorizationAction = Effect.fn(
  "cloud.cli_token.read_loopback_authorization_action",
)(function* (input: Queue.Dequeue<Terminal.UserInput, Cause.Done>) {
  while (true) {
    const event = yield* Queue.take(input).pipe(Effect.mapError(() => new Terminal.QuitError({})));
    const keyName = event.key.name.toLowerCase();
    if (!event.key.ctrl && !event.key.meta && keyName === "h") {
      return "headless" as const;
    }
    if (keyName === "enter" || keyName === "return") {
      return "open-browser" as const;
    }
  }
});

const waitForLoopbackAuthorization = Effect.fn("cloud.cli_token.wait_for_loopback_authorization")(
  function* <E, R>(input: {
    readonly authorizationUrl: string;
    readonly callback: Effect.Effect<string, E, R>;
    readonly terminal: Terminal.Terminal;
    readonly launchBrowser: (
      url: string,
    ) => Effect.Effect<void, ExternalLauncher.ExternalLauncherError>;
  }) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const terminalInput = yield* input.terminal.readInput;
        while (true) {
          const result = yield* Effect.raceFirst(
            input.callback.pipe(
              Effect.map((code): LoopbackAuthorizationResult => ({
                _tag: "AuthorizationCode",
                code,
              })),
            ),
            readLoopbackAuthorizationAction(terminalInput),
          );
          if (typeof result !== "string") {
            return result;
          }
          if (result === "headless") {
            return { _tag: "HeadlessRequested" } as const;
          }
          yield* input
            .launchBrowser(input.authorizationUrl)
            .pipe(
              Effect.catch(() =>
                Console.warn(
                  `Could not open a browser on this device. Open the URL above manually, or pair an updated browser through a trusted network and link in Settings.`,
                ),
              ),
            );
        }
      }),
    );
  },
);

const PersistedToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  identity: Schema.optional(Schema.String),
});
export type PersistedToken = typeof PersistedToken.Type;

const PersistedTokenJson = Schema.fromJsonString(PersistedToken);
const decodePersistedToken = Schema.decodeUnknownEffect(PersistedTokenJson);
const encodePersistedToken = Schema.encodeEffect(PersistedTokenJson);

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  token_type: Schema.String,
});

const OAuthRefreshErrorCode = Schema.Literals([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_request",
  "invalid_scope",
  "access_denied",
]);
const decodeOAuthRefreshErrorResponse = Schema.decodeUnknownOption(
  Schema.Struct({ error: OAuthRefreshErrorCode }),
);

const isPermanentRefreshStatus = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

const OidcIdentityClaimsJson = Schema.fromJsonString(
  Schema.Struct({
    email: Schema.optional(Schema.String),
    preferred_username: Schema.optional(Schema.String),
    sub: Schema.optional(Schema.String),
  }),
);
const decodeOidcIdentityClaimsJson = Schema.decodeUnknownOption(OidcIdentityClaimsJson);

function idTokenIdentity(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  const decoded = Base64Url.decodeString(payload);
  if (decoded._tag !== "Success") return null;
  const claims = decodeOidcIdentityClaimsJson(decoded.success);
  if (Option.isNone(claims)) return null;
  for (const value of [claims.value.email, claims.value.preferred_username, claims.value.sub]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export class CloudCliCredentialRemovalError extends Schema.TaggedError<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not remove the stored GOAT Connect CLI credential.";
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedError<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  {
    cause: Schema.Defect(),
    status: Schema.optional(Schema.Number),
    oauthErrorCode: Schema.optional(OAuthRefreshErrorCode),
  },
) {
  get requiresLogin(): boolean {
    return this.status !== undefined && isPermanentRefreshStatus(this.status);
  }

  override get message(): string {
    return this.requiresLogin
      ? `Could not refresh the GOAT Connect CLI credential${
          this.oauthErrorCode === undefined ? "" : ` (OAuth error: ${this.oauthErrorCode})`
        }. Run \`goat connect login\` to authorize again.`
      : "Could not refresh the GOAT Connect CLI credential.";
  }
}

export const isCloudCliCredentialRefreshError = Schema.is(CloudCliCredentialRefreshError);

export class CloudCliCredentialReadError extends Schema.TaggedError<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the stored GOAT Connect CLI credential.";
  }
}

export class CloudCliAuthorizationError extends Schema.TaggedError<CloudCliAuthorizationError>()(
  "CloudCliAuthorizationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not authorize the GOAT Connect CLI.";
  }
}

export class CloudCliAuthorizationUnsupportedError extends Schema.TaggedError<CloudCliAuthorizationUnsupportedError>()(
  "CloudCliAuthorizationUnsupportedError",
  {},
) {
  override get message() {
    return "GOAT Connect beta requires a browser approval for this computer. Pair an updated browser through local networking, Tailscale or SSH and link in Settings when a local browser is unavailable.";
  }
}

export class CloudCliAuthorizationTimeoutError extends Schema.TaggedError<CloudCliAuthorizationTimeoutError>()(
  "CloudCliAuthorizationTimeoutError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Timed out waiting for GOAT Connect authorization.";
  }
}

export class CloudCliAuthorizationDeniedError extends Schema.TaggedError<CloudCliAuthorizationDeniedError>()(
  "CloudCliAuthorizationDeniedError",
  {},
) {
  override get message(): string {
    return "GOAT Connect authorization was denied in the browser.";
  }
}

const isAuthorizationUnsupported = Schema.is(CloudCliAuthorizationUnsupportedError);

export const CloudCliTokenManagerError = Schema.Union([
  CloudCliCredentialRemovalError,
  CloudCliCredentialRefreshError,
  CloudCliCredentialReadError,
  CloudCliAuthorizationError,
  CloudCliAuthorizationUnsupportedError,
  CloudCliAuthorizationTimeoutError,
  CloudCliAuthorizationDeniedError,
]);
export type CloudCliTokenManagerError = typeof CloudCliTokenManagerError.Type;

export class CloudCliTokenManager extends Context.Service<
  CloudCliTokenManager,
  {
    readonly approveLink: (
      intent: ConnectLinkIntent,
    ) => Effect.Effect<ApprovedCliLink, CloudCliTokenManagerError | Terminal.QuitError>;
    readonly get: Effect.Effect<
      | { readonly _tag: "Authorized"; readonly token: PersistedToken }
      | { readonly _tag: "HeadlessRequested" },
      CloudCliTokenManagerError | Terminal.QuitError
    >;
    readonly getExisting: Effect.Effect<Option.Option<PersistedToken>, CloudCliTokenManagerError>;
    readonly hasCredential: Effect.Effect<boolean, CloudCliTokenManagerError>;
    readonly store: (token: PersistedToken) => Effect.Effect<void, CloudCliTokenManagerError>;
    readonly clear: Effect.Effect<void, CloudCliTokenManagerError>;
  }
>()("goat/cloud/CliTokenManager/CloudCliTokenManager") {}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

const readTokenResponse = Effect.fn("cloud.cli_token.read_token_response")(function* (
  response: HttpClientResponse.HttpClientResponse,
  params: Record<string, string>,
) {
  const body = yield* HttpClientResponse.schemaBodyJson(OAuthTokenResponse)(response);
  const now = yield* Clock.currentTimeMillis;
  const identity = idTokenIdentity(body.id_token);
  return {
    token: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? params.refresh_token ?? "",
      expiresAtEpochMs: now + body.expires_in * 1_000,
      ...(identity === null ? {} : { identity }),
    } satisfies PersistedToken,
    identity,
  };
});

const exchangeToken = Effect.fn("cloud.cli_token.exchange")(function* (
  metadata: Pick<CloudCliOAuthConfig, "tokenEndpoint">,
  params: Record<string, string>,
) {
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const startedAt = yield* Clock.monotonicTimeNanos;
  return yield* HttpClientRequest.post(metadata.tokenEndpoint).pipe(
    HttpClientRequest.bodyUrlParams(params),
    httpClient.execute,
    Effect.flatMap((response) => readTokenResponse(response, params)),
    Effect.timeout(OAUTH_REQUEST_TIMEOUT),
    Effect.catchTags({
      // The enclosing operation owns the span for this inline handler.
      HttpClientError: Effect.fnUntraced(function* (cause) {
        const reason = cause.reason;
        if (
          params.grant_type !== "refresh_token" ||
          reason._tag !== "StatusCodeError" ||
          !isPermanentRefreshStatus(reason.response.status)
        ) {
          return yield* cause;
        }
        // Reading a rejection body shares the exchange budget without losing
        // the known status when the body stalls or cannot be decoded.
        const elapsed = Duration.toMillis(
          Duration.nanos((yield* Clock.monotonicTimeNanos) - startedAt),
        );
        const body = yield* reason.response.json.pipe(
          Effect.timeout(Math.max(0, Duration.toMillis(OAUTH_REQUEST_TIMEOUT) - elapsed)),
          Effect.mapError(
            (cause) =>
              new CloudCliCredentialRefreshError({
                status: reason.response.status,
                cause: new HttpClientError.HttpClientError({
                  reason: new HttpClientError.StatusCodeError({
                    request: reason.request,
                    response: reason.response,
                    cause,
                  }),
                }),
              }),
          ),
        );
        const diagnostic = decodeOAuthRefreshErrorResponse(body);
        return yield* new CloudCliCredentialRefreshError({
          cause,
          status: reason.response.status,
          ...(Option.isSome(diagnostic) ? { oauthErrorCode: diagnostic.value.error } : {}),
        });
      }),
    }),
  );
});

const makePkceRequest = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const verifier = Base64Url.encode(yield* crypto.randomBytes(32));
  const challenge = Base64Url.encode(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const state = Base64Url.encode(yield* crypto.randomBytes(16));
  return { verifier, challenge, state };
});

export interface DeviceAuthorizationPrompt {
  readonly verificationUri: string;
  readonly verificationUriComplete: string | undefined;
  readonly userCode: string;
  readonly expiresIn: Duration.Duration;
}

export const deviceAuthorizationLogin = Effect.fn("cloud.cli_token.device_authorization_login")(
  function* <E, R>(_showPrompt: (prompt: DeviceAuthorizationPrompt) => Effect.Effect<void, E, R>) {
    return yield* new CloudCliAuthorizationUnsupportedError({});
  },
);

/** @public */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const services = Context.make(Crypto.Crypto, crypto).pipe(
    Context.add(HttpClient.HttpClient, httpClient),
  );
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const terminal = yield* Terminal.Terminal;
  const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
  const semaphore = yield* Semaphore.make(1);
  const persist = Effect.fn("cloud.cli_token.persist")(function* (token: PersistedToken) {
    const encoded = yield* encodePersistedToken(token);
    yield* secrets.set(CLOUD_CLI_OAUTH_TOKEN_SECRET, stringToBytes(encoded));
    return token;
  });

  const clear = secrets
    .remove(CLOUD_CLI_OAUTH_TOKEN_SECRET)
    .pipe(Effect.mapError((cause) => new CloudCliCredentialRemovalError({ cause })));

  const read = Effect.fn("cloud.cli_token.read")(function* () {
    const encoded = yield* secrets.get(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    if (Option.isNone(encoded)) return Option.none<PersistedToken>();
    return Option.some(yield* decodePersistedToken(bytesToString(encoded.value)));
  });

  const refresh = Effect.fn("cloud.cli_token.refresh")(function* (token: PersistedToken) {
    const metadata = yield* cloudCliOAuthConfig;
    const { token: refreshed } = yield* exchangeToken(metadata, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: metadata.clientId,
    });
    return refreshed.identity === undefined && token.identity !== undefined
      ? { ...refreshed, identity: token.identity }
      : refreshed;
  });

  const login = Effect.fn("cloud.cli_token.login")(function* (intent?: ConnectLinkIntent) {
    const metadata = yield* cloudCliOAuthConfig;
    const hostedAppUrl = yield* hostedAppUrlConfig;
    const { verifier, challenge, state } = yield* makePkceRequest;
    if (!intent) return yield* new CloudCliAuthorizationUnsupportedError({});
    const approvalRequest = yield* makePkceRequest;
    const key = yield* Effect.try(() => createCliApprovalKey());
    const approvalCallback = yield* Deferred.make<string>();
    const callback = yield* Deferred.make<string>();
    const originHeaders = {
      "access-control-allow-origin": hostedAppUrl,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
      "access-control-allow-private-network": "true",
      "cache-control": "no-store",
      vary: "Origin",
    };
    const layerApprovalRoute = HttpRouter.add(
      "POST",
      "/approval",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (
          !acceptsCliApprovalPost({
            method: request.method,
            origin: request.headers.origin,
            expectedOrigin: hostedAppUrl,
            contentLength: request.headers["content-length"],
          })
        )
          return HttpServerResponse.empty({ status: 403 });
        const raw = yield* request.text;
        if (raw.length > 16384) return HttpServerResponse.empty({ status: 413 });
        const decoded = yield* decodeUnknownJson(raw).pipe(
          Effect.flatMap(decodeCliApprovalCallback),
          Effect.option,
        );
        if (
          decoded._tag === "None" ||
          decoded.value.state !== state ||
          (yield* Deferred.isDone(approvalCallback))
        )
          return HttpServerResponse.empty({ status: 400, headers: originHeaders });
        const expires = Date.parse(decoded.value.expiresAt);
        if (!Number.isFinite(expires) || expires <= (yield* Clock.currentTimeMillis))
          return HttpServerResponse.empty({ status: 400, headers: originHeaders });
        yield* Deferred.succeed(approvalCallback, decoded.value.approval);
        return HttpServerResponse.text("Approved", { headers: originHeaders });
      }),
    );
    const layerApprovalOptions = HttpRouter.add(
      "OPTIONS",
      "/approval",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return HttpServerResponse.empty({
          status: request.headers.origin === hostedAppUrl ? 204 : 403,
          headers: request.headers.origin === hostedAppUrl ? originHeaders : {},
        });
      }),
    );
    const layerCallbackRoute = HttpRouter.add(
      "GET",
      "/callback",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.originalUrl, metadata.redirectUri);
        const code = url.searchParams.get("code");
        if (
          url.searchParams.get("state") !== state ||
          !code ||
          (yield* Deferred.isDone(callback))
        ) {
          return HttpServerResponse.text("Invalid GOAT Connect authorization callback.", {
            status: 400,
          });
        }
        yield* Deferred.succeed(callback, code);
        return (yield* Deferred.isDone(approvalCallback))
          ? HttpServerResponse.html(renderLoopbackAuthorizationCompleteHtml())
          : HttpServerResponse.text(
              "Authorization code received. Waiting for the matching browser approval.",
            );
      }),
    );
    yield* HttpRouter.serve(
      Layer.mergeAll(layerCallbackRoute, layerApprovalRoute, layerApprovalOptions),
      {
        disableListenLog: true,
        disableLogger: true,
      },
    ).pipe(
      Layer.provide(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: metadata.loopbackPort,
          disablePreemptiveShutdown: true,
        }),
      ),
      Layer.build,
    );
    // /connect establishes a Clerk session first; /oauth/authorize loses parameters across sign-in.
    const authorizationUrl = buildConnectAuthorizeRequestUrl({
      hostedAppUrl,
      state,
      challenge,
      loopbackPort: metadata.loopbackPort,
      approval: {
        intent,
        cliKeyThumbprint: key.thumbprint,
        approvalChallenge: approvalRequest.challenge,
        state,
      },
    });
    yield* Console.log(formatLoopbackAuthorizationPrompt(authorizationUrl));
    const authorization = yield* waitForLoopbackAuthorization({
      authorizationUrl,
      callback: Effect.all([Deferred.await(callback), Deferred.await(approvalCallback)]).pipe(
        Effect.map(([code]) => code),
        Effect.timeout(CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT),
        Effect.catchTags({
          TimeoutError: (cause) => Effect.fail(new CloudCliAuthorizationTimeoutError({ cause })),
        }),
      ),
      terminal,
      launchBrowser: externalLauncher.launchBrowser,
    });
    if (authorization._tag === "HeadlessRequested") {
      return yield* new CloudCliAuthorizationError({
        cause:
          "Headless Connect authorization is unavailable in beta. Pair an updated browser over a trusted local, Tailscale or SSH connection and link in Settings.",
      });
    }
    const { token } = yield* exchangeToken(metadata, {
      grant_type: "authorization_code",
      code: authorization.code,
      redirect_uri: metadata.redirectUri,
      client_id: metadata.clientId,
      code_verifier: verifier,
    });
    return {
      _tag: "Authorized",
      token,
      approval: yield* Deferred.await(approvalCallback),
      approvalVerifier: approvalRequest.verifier,
      approvalState: state,
      key,
    } as const;
  });

  const getExistingNoLock = Effect.fn("cloud.cli_token.get_existing_no_lock")(function* () {
    const token = yield* read();
    if (Option.isNone(token)) return token;
    const now = yield* Clock.currentTimeMillis;
    if (token.value.expiresAtEpochMs - CLOUD_CLI_OAUTH_REFRESH_EARLY_MS > now) {
      return token;
    }
    return Option.some(
      // The endpoint can rotate the refresh token before shutdown interrupts us.
      // Keep the lock through persistence; the exchange still times out internally.
      yield* refresh(token.value).pipe(Effect.flatMap(persist), Effect.uninterruptible),
    );
  });

  const getExisting = semaphore.withPermits(1)(
    getExistingNoLock().pipe(
      Effect.mapError((cause) =>
        isCloudCliCredentialRefreshError(cause)
          ? cause
          : new CloudCliCredentialRefreshError({
              cause,
              ...(HttpClientError.isHttpClientError(cause) &&
              cause.reason._tag === "StatusCodeError"
                ? { status: cause.reason.response.status }
                : {}),
            }),
      ),
      Effect.provide(services),
    ),
  );
  const hasCredential = semaphore.withPermits(1)(
    read().pipe(
      Effect.map(Option.isSome),
      Effect.mapError((cause) => new CloudCliCredentialReadError({ cause })),
    ),
  );
  const get = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const token = yield* getExistingNoLock().pipe(
        Effect.orElseSucceed(() => Option.none<PersistedToken>()),
      );
      if (Option.isSome(token)) {
        return { _tag: "Authorized", token: token.value } as const;
      }
      const authorization = yield* Effect.scoped(login());
      return authorization._tag === "Authorized"
        ? ({ _tag: "Authorized", token: yield* persist(authorization.token) } as const)
        : authorization;
    }).pipe(
      Effect.mapError((cause) =>
        Terminal.isQuitError(cause) || isAuthorizationUnsupported(cause)
          ? cause
          : new CloudCliAuthorizationError({ cause }),
      ),
      Effect.provide(services),
    ),
  );
  const store = Effect.fn("cloud.cli_token.store")(function* (token: PersistedToken) {
    yield* semaphore.withPermits(1)(
      persist(token).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new CloudCliAuthorizationError({ cause })),
      ),
    );
  });

  const approveLink = Effect.fn("cloud.cli_token.approve_link")(function* (
    intent: ConnectLinkIntent,
  ) {
    return yield* semaphore
      .withPermits(1)(
        Effect.scoped(login(intent)).pipe(
          Effect.flatMap((approved) => persist(approved.token).pipe(Effect.as(approved))),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          Terminal.isQuitError(cause) || isAuthorizationUnsupported(cause)
            ? cause
            : new CloudCliAuthorizationError({ cause }),
        ),
        Effect.provide(services),
      );
  });
  return CloudCliTokenManager.of({ get, approveLink, getExisting, hasCredential, store, clear });
});

export const layer = Layer.effect(CloudCliTokenManager, make);
