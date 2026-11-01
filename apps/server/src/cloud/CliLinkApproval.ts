import * as ServerConfig from "../config.ts";
import * as BootService from "./bootService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
// @effect-diagnostics nodeBuiltinImport:off -- CLI approval keys never leave this Node process.
import * as NodeCrypto from "node:crypto";
import { DpopPublicJwk, computeDpopJwkThumbprint } from "@goat/shared/dpop";
import { type ConnectLinkIntent, CliLinkApprovalResponse } from "@goat/contracts/connectAssurance";
import {
  RelayEnvironmentLinkChallengeResponse,
  RelayEnvironmentLinkResponse,
} from "@goat/contracts/relay";
import { EnvironmentHttpApi, AuthRelayWriteScope } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { filterRelayResponse } from "./relayResponse.ts";
import { relayUrlConfig } from "./publicConfig.ts";

const decodePublicJwk = Schema.decodeUnknownSync(DpopPublicJwk);

export function createCliApprovalKey() {
  const pair = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = decodePublicJwk(pair.publicKey.export({ format: "jwk" }));
  return {
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicJwk,
    thumbprint: computeDpopJwkThumbprint(publicJwk),
  };
}
export type CliApprovalKey = ReturnType<typeof createCliApprovalKey>;

export function createCliApprovalProof(key: CliApprovalKey, url: string, now: number) {
  const header = Base64Url.encode(
    new TextEncoder().encode(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk })),
  );
  const payload = Base64Url.encode(
    new TextEncoder().encode(
      JSON.stringify({ htm: "POST", htu: url, iat: now, jti: NodeCrypto.randomUUID() }),
    ),
  );
  const message = `${header}.${payload}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(message), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${message}.${Base64Url.encode(signature)}`;
}

export function acceptsCliApprovalPost(input: {
  readonly method: string;
  readonly origin: string | undefined;
  readonly expectedOrigin: string;
  readonly contentLength: string | undefined;
}): boolean {
  return (
    input.method === "POST" &&
    input.origin === input.expectedOrigin &&
    input.contentLength !== undefined &&
    /^\d+$/.test(input.contentLength) &&
    Number(input.contentLength) <= 16384
  );
}

export const decodeCliApprovalCallback = Schema.decodeUnknownEffect(
  Schema.Struct({
    state: Schema.String,
    ...CliLinkApprovalResponse.fields,
  }),
);

export interface ApprovedCliLink {
  readonly approval: string;
  readonly approvalVerifier: string;
  readonly approvalState: string;
  readonly key: CliApprovalKey;
  readonly token: { readonly accessToken: string; readonly identity?: string };
}

export const installApprovedCliLink = Effect.fn("CliLinkApproval.install")(function* (
  intent: ConnectLinkIntent,
  approved: ApprovedCliLink,
  origin: string,
) {
  const relayUrl = yield* relayUrlConfig;
  const http = yield* HttpClient.HttpClient;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* environmentAuth.issueSession({
    label: "GOAT Connect CLI approval",
    scopes: [AuthRelayWriteScope],
    subject: "cloud-cli",
  });
  return yield* Effect.gen(function* () {
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
    const headers = { authorization: `Bearer ${session.token}` };
    const post = Effect.fn("CliLinkApproval.post")(function* <A>(
      path: string,
      body: unknown,
      schema: Schema.Decoder<A>,
    ) {
      const url = `${relayUrl}${path}`;
      const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      const proof = yield* Effect.try(() => createCliApprovalProof(approved.key, url, now));
      return yield* HttpClientRequest.post(url).pipe(
        HttpClientRequest.bearerToken(approved.token.accessToken),
        HttpClientRequest.setHeader("dpop", proof),
        HttpClientRequest.bodyJson(body),
        Effect.flatMap(http.execute),
        Effect.flatMap(filterRelayResponse),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.timeout("2 minutes"),
      );
    });
    const challenge = yield* post(
      "/v1/client/environment-link-challenges",
      {
        ...intent,
        cliApproval: approved.approval,
        approvalVerifier: approved.approvalVerifier,
        approvalState: approved.approvalState,
      },
      RelayEnvironmentLinkChallengeResponse,
    );
    const localUrl = new URL(origin);
    const proof = yield* client.connect.linkProof({
      headers,
      payload: {
        challenge: challenge.challenge,
        relayIssuer: relayUrl,
        endpoint: {
          httpBaseUrl: origin,
          wsBaseUrl: `${localUrl.protocol === "https:" ? "wss:" : "ws:"}//${localUrl.host}`,
          providerKind: intent.managedTunnelsEnabled ? "cloudflare_tunnel" : "manual",
        },
        origin: intent.origin,
      },
    });
    const link = yield* post(
      "/v1/client/environment-links",
      {
        proof,
        notificationsEnabled: false,
        liveActivitiesEnabled: false,
        managedTunnelsEnabled: intent.managedTunnelsEnabled,
      },
      RelayEnvironmentLinkResponse,
    );
    if (link.environmentId !== intent.environmentId || link.connectAuthPolicyVersion !== 1)
      return yield* new EnvironmentAuth.ServerAuthLinkedCloudAccountMissingError({});
    yield* client.connect.relayConfig({
      headers,
      payload: {
        relayUrl,
        relayIssuer: link.relayIssuer,
        cloudUserId: link.cloudUserId,
        environmentCredential: link.environmentCredential,
        cloudMintPublicKey: link.cloudMintPublicKey,
        connectAuthPolicyVersion: 1,
        endpointRuntime: link.endpointRuntime,
      },
    });
    return approved.token.identity ?? null;
  }).pipe(
    Effect.ensuring(
      environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    ),
  );
});

export class CliLinkApprovalHostUnavailableError extends Schema.TaggedError<CliLinkApprovalHostUnavailableError>()(
  "CliLinkApprovalHostUnavailableError",
  {},
) {
  override get message() {
    return "Start an updated GOAT server on this machine, then run goat connect again.";
  }
}

export const prepareCliLinkIntent = Effect.fn("CliLinkApproval.prepare")(function* (
  managedTunnelsEnabled: boolean,
) {
  const config = yield* ServerConfig.ServerConfig;
  let runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (runtime._tag === "None") {
    const service = yield* BootService.BootService;
    yield* service.install({ start: true });
    runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  }
  if (runtime._tag === "None") return yield* new CliLinkApprovalHostUnavailableError({});
  const origin = new URL(runtime.value.origin);
  if (
    origin.hostname !== "127.0.0.1" &&
    origin.hostname !== "localhost" &&
    origin.hostname !== "[::1]"
  )
    return yield* new CliLinkApprovalHostUnavailableError({});
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const key = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
  return {
    origin: origin.origin,
    intent: {
      connectAuthPolicyVersion: 1 as const,
      environmentId: yield* identity.getEnvironmentId,
      environmentPublicKey: key.publicKey.trim(),
      origin: {
        localHttpHost: origin.hostname === "[::1]" ? "::1" : origin.hostname,
        localHttpPort: Number(origin.port || (origin.protocol === "https:" ? "443" : "80")),
      },
      notificationsEnabled: false as const,
      liveActivitiesEnabled: false as const,
      managedTunnelsEnabled,
    },
  };
});
