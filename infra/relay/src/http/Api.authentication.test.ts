import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createClerkClient, verifyToken } from "@clerk/backend";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { verifyRelayClientBearerToken as verifyBearer } from "./Api.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ConnectAccounts from "../auth/ConnectAccounts.ts";
vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn(), verifyToken: vi.fn() }));
const accounts = ConnectAccounts.ConnectAccounts.of({
  authorize: () => Effect.succeed(1),
  check: () => Effect.succeed(true),
});
const verifyRelayClientBearerToken = (
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
  oauthAllowed = false,
) =>
  verifyBearer(config, token, oauthAllowed).pipe(
    Effect.provideService(ConnectAccounts.ConnectAccounts, accounts),
  );
const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "apns-team",
    keyId: "apns-key",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.example.t3",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: `pk_test_${btoa("clerk.example.test$")}`,
  clerkAuthorizedParties: ["https://app.example.test"],
  clerkCliOAuthClientId: "cli-client",
  clerkJwtAudience: "https://relay.example.test",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

describe("relay client authentication", () => {
  it.effect("rejects a verified session without MFA instead of falling through to OAuth", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_weak",
        iss: "https://clerk.example.test",
        azp: "https://app.example.test",
        aud: relaySettings.clerkJwtAudience,
      } as never);
      const result = yield* verifyRelayClientBearerToken(relaySettings, "weak-session", true).pipe(
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(createClerkClient).not.toHaveBeenCalled();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );
  it.effect("accepts only an active, strong Clerk session", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1800000000000);
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_session",
        sid: "session-1",
        iss: "https://clerk.example.test",
        azp: "https://app.example.test",
        aud: relaySettings.clerkJwtAudience,
        v: 2,
        fva: [0, 0],
        iat: 1800000000,
        exp: 1800000060,
      } as never);
      vi.mocked(createClerkClient).mockReturnValue({
        sessions: {
          getSession: vi.fn().mockResolvedValue({ userId: "user_session", status: "active" }),
        },
      } as never);
      const verified = yield* verifyRelayClientBearerToken(relaySettings, "session-token");
      expect(verified.sub).toBe("user_session");
      expect(verified.authentication.source).toBe("clerk-session");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );
  it.effect(
    "allows configured OAuth identity solely when the caller selects a CLI link or withdrawal operation",
    () =>
      Effect.gen(function* () {
        vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
        vi.mocked(createClerkClient).mockReturnValue({
          authenticateRequest: vi.fn().mockResolvedValue({
            isAuthenticated: true,
            toAuth: () => ({
              tokenType: "oauth_token",
              userId: "user_oauth",
              clientId: "cli-client",
              scopes: ["openid", "profile", "email", "offline_access"],
            }),
          }),
        } as never);
        expect(
          (yield* verifyRelayClientBearerToken(relaySettings, "oauth-token").pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect((yield* verifyRelayClientBearerToken(relaySettings, "oauth-token", true)).sub).toBe(
          "user_oauth",
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            vi.mocked(verifyToken).mockReset();
            vi.mocked(createClerkClient).mockReset();
          }),
        ),
      ),
  );
});
