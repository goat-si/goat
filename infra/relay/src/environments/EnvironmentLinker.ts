import * as ConnectAccounts from "../auth/ConnectAccounts.ts";
import { strengthRequired } from "../auth/ConnectAuthentication.ts";
import {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkProofInvalidReason,
  type RelayEnvironmentLinkRequest,
} from "@goat/contracts/relay";
import {
  decodeRelayJwt,
  normalizeRelayIssuer,
  RELAY_LINK_PROOF_TYP,
  verifyRelayJwt,
} from "@goat/shared/relayJwt";
import { isConnectAssuranceFresh } from "@goat/contracts/connectAssurance";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as ConnectLinkReservations from "./ConnectLinkReservations.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as RelayConfiguration from "../Config.ts";

export class EnvironmentLinkProofExpired extends Schema.TaggedError<EnvironmentLinkProofExpired>()(
  "EnvironmentLinkProofExpired",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' link proof expired at ${this.expiresAt}`;
  }
}

export class EnvironmentLinkProofInvalid extends Schema.TaggedError<EnvironmentLinkProofInvalid>()(
  "EnvironmentLinkProofInvalid",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    reason: RelayEnvironmentLinkProofInvalidReason,
    stage: Schema.Literals([
      "decode_token",
      "decode_payload",
      "verify_proof",
      "authorize_capabilities",
      "validate_descriptor",
      "verify_challenge",
      "validate_expiration",
      "consume_proof_nonce",
      "consume_challenge_nonce",
      "validate_origin",
      "validate_endpoint",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' link proof is invalid during ${this.stage}: ${this.reason}`;
  }
}

export type EnvironmentLinkError =
  | EnvironmentLinkProofExpired
  | import("@goat/contracts/relay").RelayInternalError
  | import("@goat/contracts/connectAssurance").RelayAuthenticationStrengthError
  | EnvironmentLinkProofInvalid
  | DpopProofs.DpopProofReplayPersistenceError
  | EnvironmentLinks.EnvironmentLinkUpsertPersistenceError
  | EnvironmentCredentials.EnvironmentCredentialCreatePersistenceError
  | ManagedEndpointProvider.ManagedEndpointProviderError
  | ManagedEndpointProvider.ManagedEndpointDeprovisioningFailed;

export class EnvironmentLinker extends Context.Service<
  EnvironmentLinker,
  {
    readonly link: (input: {
      readonly userId: string;
      readonly cliKeyThumbprint?: string;
      readonly request: RelayEnvironmentLinkRequest;
    }) => Effect.Effect<
      {
        readonly environmentId: RelayEnvironmentLinkProofPayload["environmentId"];
        readonly endpoint: RelayEnvironmentLinkProofPayload["endpoint"];
        readonly endpointRuntime:
          | ManagedEndpointProvider.ManagedEndpointProvisioningResult["runtime"]
          | null;
        readonly environmentCredential: string;
      },
      EnvironmentLinkError
    >;
  }
>()("goat-relay/environments/EnvironmentLinker") {}

const decodeProof = Schema.decodeUnknownEffect(RelayEnvironmentLinkProofPayload);

function proofAuthorizesRequestedCapabilities(
  proof: RelayEnvironmentLinkProofPayload,
  request: RelayEnvironmentLinkRequest,
): boolean {
  const scopes = new Set(proof.scopes);
  if (request.managedTunnelsEnabled && !scopes.has("managed_tunnels")) {
    return false;
  }
  return !(
    (request.notificationsEnabled || request.liveActivitiesEnabled) &&
    !scopes.has("agent_activity_notifications")
  );
}

function isSecureManagedEndpoint(endpoint: RelayEnvironmentLinkProofPayload["endpoint"]): boolean {
  try {
    const httpUrl = new URL(endpoint.httpBaseUrl);
    const wsUrl = new URL(endpoint.wsBaseUrl);
    return httpUrl.protocol === "https:" && wsUrl.protocol === "wss:";
  } catch {
    return false;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1");
}

function isLoopbackManagedTunnelOrigin(
  origin: RelayEnvironmentLinkProofPayload["origin"],
): boolean {
  const hostname = normalizeHostname(origin.localHttpHost);
  return (
    (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost") &&
    Number.isInteger(origin.localHttpPort) &&
    origin.localHttpPort > 0 &&
    origin.localHttpPort <= 65_535
  );
}

const make = Effect.gen(function* () {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const reservations = yield* ConnectLinkReservations.ConnectLinkReservations;
  const crypto = yield* Crypto.Crypto;
  const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
  const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
  const proofReplay = yield* DpopProofs.DpopProofReplay;
  const relayTokens = yield* RelayTokens.RelayTokens;
  const accounts = yield* ConnectAccounts.ConnectAccounts;
  const config = yield* RelayConfiguration.RelayConfiguration;

  return EnvironmentLinker.of({
    link: Effect.fn("relay.environment_linker.link")(function* (input) {
      const now = yield* DateTime.now;
      const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
      const unverified = yield* Effect.try({
        try: () => decodeRelayJwt(input.request.proof),
        catch: (cause) =>
          new EnvironmentLinkProofInvalid({
            userId: input.userId,
            environmentId: "unknown",
            reason: "invalid_signature_or_scope",
            stage: "decode_token",
            cause,
          }),
      });
      const candidate = yield* decodeProof(unverified).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentLinkProofInvalid({
              userId: input.userId,
              environmentId: "unknown",
              reason: "invalid_signature_or_scope",
              stage: "decode_payload",
              cause,
            }),
        ),
      );
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": candidate.environmentId,
        "relay.link.notifications_enabled": input.request.notificationsEnabled,
        "relay.link.live_activities_enabled": input.request.liveActivitiesEnabled,
        "relay.link.managed_tunnels_enabled": input.request.managedTunnelsEnabled,
      });
      if (candidate.exp <= nowSeconds) {
        return yield* new EnvironmentLinkProofExpired({
          userId: input.userId,
          environmentId: candidate.environmentId,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(candidate.exp * 1_000)),
        });
      }
      const issuer = `goat-env:${candidate.environmentId}`;
      const relayIssuer = normalizeRelayIssuer(config.relayIssuer);
      const verified = yield* verifyRelayJwt({
        publicKey: candidate.environmentPublicKey,
        token: input.request.proof,
        typ: RELAY_LINK_PROOF_TYP,
        issuer,
        audience: relayIssuer,
        nowEpochSeconds: nowSeconds,
      }).pipe(
        Effect.flatMap(decodeProof),
        Effect.mapError(
          (cause) =>
            new EnvironmentLinkProofInvalid({
              userId: input.userId,
              environmentId: candidate.environmentId,
              reason: "invalid_signature_or_scope",
              stage: "verify_proof",
              cause,
            }),
        ),
      );
      if (
        verified.sub !== verified.environmentId ||
        !proofAuthorizesRequestedCapabilities(verified, input.request)
      ) {
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: candidate.environmentId,
          reason: "invalid_signature_or_scope",
          stage: "authorize_capabilities",
        });
      }
      if (verified.descriptor.environmentId !== verified.environmentId) {
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "descriptor_mismatch",
          stage: "validate_descriptor",
        });
      }
      const challenge = yield* relayTokens.verifyLinkChallenge({
        token: verified.challenge,
        userId: input.userId,
        request: {
          notificationsEnabled: input.request.notificationsEnabled,
          liveActivitiesEnabled: input.request.liveActivitiesEnabled,
          managedTunnelsEnabled: input.request.managedTunnelsEnabled,
        },
        nowEpochSeconds: nowSeconds,
      });
      if (
        input.cliKeyThumbprint !== undefined &&
        (challenge === null || challenge.cliKeyThumbprint !== input.cliKeyThumbprint)
      ) {
        return yield* strengthRequired("unsupported_authentication_flow");
      }
      if (
        challenge === null ||
        verified.descriptor.connectAuthPolicyVersion !== 1 ||
        input.request.notificationsEnabled ||
        input.request.liveActivitiesEnabled ||
        challenge.intent.environmentId !== verified.environmentId ||
        challenge.intent.environmentPublicKey !== verified.environmentPublicKey ||
        challenge.intent.origin.localHttpHost !== verified.origin.localHttpHost ||
        challenge.intent.origin.localHttpPort !== verified.origin.localHttpPort ||
        challenge.intent.managedTunnelsEnabled !== input.request.managedTunnelsEnabled ||
        challenge.cliKeyThumbprint !== input.cliKeyThumbprint
      ) {
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "challenge_invalid",
          stage: "verify_challenge",
        });
      }
      if (!(yield* accounts.check(input.userId, challenge.assurance.authGeneration)))
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "challenge_invalid",
          stage: "verify_challenge",
        });
      const expiresAt = DateTime.make(verified.exp * 1_000);
      if (expiresAt._tag === "None") {
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "invalid_signature_or_scope",
          stage: "validate_expiration",
        });
      }
      if (input.request.managedTunnelsEnabled && !isLoopbackManagedTunnelOrigin(verified.origin)) {
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "origin_not_allowed",
          stage: "validate_origin",
        });
      }
      const reservation = {
        userId: input.userId,
        challengeId: challenge.jti,
        attemptId: yield* crypto.randomUUIDv4().pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkProofInvalid({
                userId: input.userId,
                environmentId: verified.environmentId,
                reason: "invalid_signature_or_scope",
                stage: "verify_proof",
                cause,
              }),
          ),
        ),
        environmentId: verified.environmentId,
        proof: Hex.encode(
          yield* crypto.digest("SHA-256", new TextEncoder().encode(input.request.proof)).pipe(
            Effect.mapError(
              () =>
                new EnvironmentLinkProofInvalid({
                  userId: input.userId,
                  environmentId: verified.environmentId,
                  reason: "invalid_signature_or_scope",
                  stage: "verify_proof",
                }),
            ),
          ),
        ),
        assurance: challenge.assurance,
        managedTunnelsEnabled: input.request.managedTunnelsEnabled,
      };
      return yield* reservations.exclusive(input.userId, (assertOwner) =>
        Effect.gen(function* () {
          const cleanup = Effect.fn("EnvironmentLinker.cleanup")(function* (
            environmentId: string,
            target?: ManagedEndpointProvider.ManagedEndpointDeprovisionTarget | null,
          ) {
            yield* assertOwner;
            const key = { userId: input.userId, environmentId };
            const captured =
              target === undefined
                ? yield* managedEndpointProvider.prepareDeprovision(key)
                : target;
            yield* assertOwner;
            if (!(yield* managedEndpointProvider.deprovision({ ...key, target: captured }))) {
              return yield* new ManagedEndpointProvider.ManagedEndpointDeprovisioningFailed({
                ...key,
                stage: "claim-deprovision",
                cause: "claim lost",
              });
            }
          });
          yield* assertOwner;
          yield* reservations.recover(input.userId, assertOwner, (environmentId) =>
            cleanup(environmentId),
          );
          let cleanupTarget:
            | ManagedEndpointProvider.ManagedEndpointDeprovisionTarget
            | null
            | undefined;
          yield* assertOwner;
          const prior = yield* reservations.reserve(
            reservation,
            Effect.gen(function* () {
              const consumeNow = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
              if (
                verified.exp <= consumeNow ||
                challenge.exp <= consumeNow ||
                !isConnectAssuranceFresh(challenge.assurance, consumeNow)
              )
                return yield* new EnvironmentLinkProofInvalid({
                  userId: input.userId,
                  environmentId: verified.environmentId,
                  reason: "challenge_invalid",
                  stage: "consume_challenge_nonce",
                });
              const consumedNonce = yield* proofReplay.consume({
                thumbprint: verified.environmentPublicKey,
                jti: verified.jti,
                iat: verified.iat,
                expiresAt: expiresAt.value,
              });
              if (!consumedNonce) {
                return yield* new EnvironmentLinkProofInvalid({
                  userId: input.userId,
                  environmentId: verified.environmentId,
                  reason: "replayed_nonce",
                  stage: "consume_proof_nonce",
                });
              }
              const consumedChallenge = yield* proofReplay.consume({
                thumbprint: "relay-environment-link-challenge",
                jti: challenge.jti,
                iat: challenge.iat,
                expiresAt: expiresAt.value,
              });
              if (!consumedChallenge) {
                return yield* new EnvironmentLinkProofInvalid({
                  userId: input.userId,
                  environmentId: verified.environmentId,
                  reason: "challenge_invalid",
                  stage: "consume_challenge_nonce",
                });
              }
            }),
          );
          if (prior) return prior;
          return yield* Effect.gen(function* () {
            yield* assertOwner;
            if (!input.request.managedTunnelsEnabled) {
              yield* cleanup(verified.environmentId);
            }
            const provisioned = input.request.managedTunnelsEnabled
              ? yield* managedEndpointProvider.provision({
                  userId: input.userId,
                  environmentId: verified.environmentId,
                  origin: verified.origin,
                })
              : null;
            yield* assertOwner;
            cleanupTarget = input.request.managedTunnelsEnabled
              ? yield* managedEndpointProvider.prepareDeprovision(reservation)
              : null;
            const endpoint = provisioned?.endpoint ?? verified.endpoint;
            // Only advertised managed endpoints need secure URLs; publish-only links route out of band.
            if (input.request.managedTunnelsEnabled && !isSecureManagedEndpoint(endpoint)) {
              return yield* new EnvironmentLinkProofInvalid({
                userId: input.userId,
                environmentId: verified.environmentId,
                reason: "endpoint_not_secure",
                stage: "validate_endpoint",
              });
            }
            yield* assertOwner;
            return yield* reservations.complete(
              reservation,
              Effect.gen(function* () {
                yield* links.upsert({ ...input, proof: verified, endpoint });
                const environmentCredential = yield* credentials.create({
                  environmentId: verified.environmentId,
                  environmentPublicKey: verified.environmentPublicKey,
                });
                return {
                  environmentId: verified.environmentId,
                  endpoint,
                  endpointRuntime: provisioned?.runtime ?? null,
                  environmentCredential,
                };
              }),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (input.request.managedTunnelsEnabled) {
                  yield* cleanup(verified.environmentId, cleanupTarget);
                }
                yield* reservations.failed(reservation);
              }).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          );
        }),
      );
    }),
  });
});

export const layer = Layer.effect(EnvironmentLinker, make);
