import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
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
import { postgresFixture } from "./connectPostgres.testkit.ts";
import { config, intent, makeAssurance } from "../environments/EnvironmentLinker.testkit.ts";

const layer = Layer.mergeAll(Approvals.layer, Tokens.layer, RelayDb.RelayTransactions.layer).pipe(
  Layer.provideMerge(Replay.layer),
  Layer.provideMerge(ConnectAccounts.layer),
  Layer.provideMerge(postgresFixture),
  Layer.provideMerge(Config.layer(config)),
  Layer.provideMerge(NodeCrypto.layer),
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
          Layer.provide(
            Config.layer({ ...config, cloudMintPrivateKey: Redacted.make("invalid-signing-key") }),
          ),
        ),
      );
      expect(
        (yield* createLinkChallenge(input).pipe(
          Effect.provideService(Tokens.RelayTokens, Context.get(invalidSigner, Tokens.RelayTokens)),
          Effect.result,
        ))._tag,
      ).toBe("Failure");
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
