import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Base64Url from "effect/encoding/Base64Url";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as Approvals from "./CliLinkApprovals.ts";
import * as Replay from "./DpopProofs.ts";
import * as Tokens from "./RelayTokens.ts";
import { createLinkChallenge } from "./ConnectLinkChallenges.ts";
import { awaitPostgresMilestone, postgresFixture } from "./connectPostgres.testkit.ts";
import { config, intent, makeAssurance } from "../environments/EnvironmentLinker.testkit.ts";

const layer = Layer.mergeAll(Approvals.layer, Tokens.layer).pipe(
  Layer.provideMerge(Replay.layer),
  Layer.provideMerge(postgresFixture),
  Layer.provideMerge(Config.layer(config)),
  Layer.provideMerge(NodeCrypto.layer),
);

it.effect(
  "a missing worker service fails a PostgreSQL milestone wait with the original defect",
  () =>
    Effect.gen(function* () {
      const milestone = yield* Deferred.make<void>();
      const worker = yield* Effect.sync(() =>
        Context.getUnsafe(Context.empty(), ConnectAccounts.ConnectAccounts),
      ).pipe(Effect.forkChild);
      const outcome = yield* awaitPostgresMilestone(milestone, worker).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(Cause.squash(outcome.cause)).toMatchObject({
          message: "Service not found: goat-relay/auth/ConnectAccounts",
        });
      }
    }),
);

it.effect(
  "challenge signing failure rolls back approval consumption and the same approval can retry",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1800000000000);
      yield* (yield* ConnectAccounts.ConnectAccounts).authorize("user_123");
      const crypto = yield* Crypto.Crypto;
      const verifier = "v".repeat(64);
      const approvalChallenge = Base64Url.encode(
        yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
      );
      const approvals = yield* Approvals.CliLinkApprovals;
      const signed = yield* approvals.issue(
        { intent, cliKeyThumbprint: "cli-key", approvalChallenge, state: "state" },
        makeAssurance(1800000000),
      );
      const input = {
        userId: "user_123",
        authentication: {
          source: "clerk-oauth" as const,
          oauthClientId: "cli-client",
          assurance: null,
        },
        thumbprint: "cli-key",
        request: {
          ...intent,
          cliApproval: signed.approval,
          approvalVerifier: verifier,
          approvalState: "state",
        },
      };
      const invalidSigner = yield* Layer.build(
        Tokens.layer.pipe(
          // This signer must not reuse the valid service from the enclosing fixture's memo map.
          Layer.fresh,
          Layer.provide(
            Config.layer({ ...config, cloudMintPrivateKey: Redacted.make("invalid-signing-key") }),
          ),
        ),
      );
      const failed = yield* createLinkChallenge(input).pipe(
        Effect.provideService(Tokens.RelayTokens, Context.get(invalidSigner, Tokens.RelayTokens)),
        Effect.result,
      );
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure") {
        expect(failed.failure).toMatchObject({
          _tag: "RelayJwtError",
          operation: "sign",
          typ: "goat-link-challenge+jwt",
        });
      }
      const db = yield* RelayDb.RelayDb;
      expect(
        (yield* db.$client`SELECT * FROM relay_dpop_proofs WHERE thumbprint = 'cli-link-approval'`)
          .length,
      ).toBe(0);
      expect((yield* createLinkChallenge(input)).challenge).toBeTruthy();
      expect((yield* createLinkChallenge(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* db.$client`SELECT * FROM relay_dpop_proofs WHERE thumbprint = 'cli-link-approval'`)
          .length,
      ).toBe(1);
    }).pipe(Effect.provide(layer), Effect.scoped),
);
