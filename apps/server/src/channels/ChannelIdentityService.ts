/**
 * ChannelIdentityService - one-time codes that link an external account to the host owner.
 *
 * Someone with settings access creates a code with a runtime ceiling; the external user sends
 * it to the bot, and the gateway consumes it. Only a hash of the code is stored.
 *
 * @module ChannelIdentityService
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- link codes need a CSPRNG digit source.
import * as NodeCrypto from "node:crypto";

import {
  type ChannelIdentityLinkCreateInput,
  type ChannelIdentityLinkCreateResult,
  type ChannelIdentityUnlinkInput,
  ChannelGatewayError,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { lowerRuntimeMode } from "./ChannelGateway.ts";
import { linkCodeHashFor } from "./channelIds.ts";

const DEFAULT_LINK_TTL_SECONDS = 10 * 60;
const MAX_LINK_TTL_SECONDS = 24 * 60 * 60;

export class ChannelIdentityService extends Context.Service<
  ChannelIdentityService,
  {
    readonly createLink: (
      input: ChannelIdentityLinkCreateInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelIdentityLinkCreateResult, ChannelGatewayError>;
    readonly unlink: (
      input: ChannelIdentityUnlinkInput,
    ) => Effect.Effect<void, ChannelGatewayError>;
  }
>()("goat/channels/ChannelIdentityService") {}

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  return ChannelIdentityService.of({
    createLink: (input, owner) =>
      Effect.gen(function* () {
        const code = String(NodeCrypto.randomInt(0, 1_000_000)).padStart(6, "0");
        const ttl = Math.min(
          input.expiresInSeconds ?? DEFAULT_LINK_TTL_SECONDS,
          MAX_LINK_TTL_SECONDS,
        );
        const now = yield* DateTime.now;
        const expiresAt = DateTime.formatIso(DateTime.addDuration(now, Duration.seconds(ttl)));
        // A link never grants more than the person creating it holds.
        const grantedScopes =
          input.grantedScopes === undefined
            ? [...owner.grantedScopes]
            : input.grantedScopes.filter((scope) => owner.grantedScopes.includes(scope));
        yield* ledger
          .createIdentityLink({
            codeHash: linkCodeHashFor(input.connectionId, code),
            connectionId: input.connectionId,
            identity: {
              ownerId: owner.ownerId,
              principalId: owner.principalId,
              displayName: owner.displayName,
              runtimeModeCeiling: lowerRuntimeMode(
                input.runtimeModeCeiling,
                owner.runtimeModeCeiling,
              ),
              grantedScopes,
            },
            expiresAt,
            now: DateTime.formatIso(now),
          })
          .pipe(Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })));
        return { code, expiresAt };
      }),
    unlink: (input) =>
      ledger.unlinkIdentity(input).pipe(
        Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })),
        Effect.flatMap((removed) =>
          removed ? Effect.void : Effect.fail(new ChannelGatewayError({ reason: "not_found" })),
        ),
      ),
  });
});

export const layer = Layer.effect(ChannelIdentityService, make);
