import * as ConnectAccounts from "./ConnectAccounts.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createClerkClient, verifyToken } from "@clerk/backend";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectAuthentication from "./ConnectAuthentication.ts";
import * as RelayConfiguration from "../Config.ts";

vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn(), verifyToken: vi.fn() }));
const NOW = 1800000000;

// The worker's ES2023 lib has no Promise.withResolvers.
function promiseWithResolvers<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}
const config = RelayConfiguration.make({
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("test-secret"),
  clerkPublishableKey: `pk_test_${btoa("clerk.example.test$")}`,
  clerkJwtAudience: "https://relay.example.test",
  clerkAuthorizedParties: ["https://app.example.test"],
  clerkCliOAuthClientId: "cli-client",
  cloudMintPrivateKey: Redacted.make("test-private"),
  cloudMintPublicKey: "test-public",
  apnsDeliveryJobSigningSecret: Redacted.make("test-delivery"),
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const claims = {
  iss: "https://clerk.example.test",
  aud: config.clerkJwtAudience,
  azp: "https://app.example.test",
  sub: "user-1",
  sid: "session-1",
  v: 2,
  fva: [0, 0],
  iat: NOW,
  exp: NOW + 60,
};

function setup() {
  vi.mocked(verifyToken).mockReset();
  vi.mocked(createClerkClient).mockReset();
  const getSession = vi.fn().mockResolvedValue({ status: "active", userId: "user-1" });
  vi.mocked(createClerkClient).mockReturnValue({ sessions: { getSession } } as never);
  return { getSession };
}
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(ConnectAuthentication.layer),
    Effect.provideService(ConnectAccounts.ConnectAccounts, {
      authorize: () => Effect.succeed(1),
      check: () => Effect.succeed(true),
    }),
    Effect.provideService(RelayConfiguration.RelayConfiguration, config),
  );

describe("Connect session assurance", () => {
  it("keeps conservative original factor times as a token travels or is refreshed", () => {
    const first = ConnectAuthentication.normalizeSessionAssurance(claims, NOW + 30, 1);
    expect(first?.firstVerifiedAtFloor).toBe(NOW - 60);
    const refreshed = ConnectAuthentication.normalizeSessionAssurance(
      { ...claims, iat: NOW + 60, exp: NOW + 120, fva: [1, 1] },
      NOW + 60,
      1,
    );
    expect(refreshed?.firstVerifiedAtFloor).toBe(first?.firstVerifiedAtFloor);
  });
  it.each([undefined, [0, -1], [-1, 0], [0], [0, 0, 0], [0, 1.5], [0, Number.MAX_SAFE_INTEGER]])(
    "denies missing or unsupported factor ages %j",
    (fva) => {
      expect(
        ConnectAuthentication.normalizeSessionAssurance({ ...claims, fva }, NOW, 1),
      ).toBeNull();
    },
  );
  it.each([
    { act: { sub: "other" } },
    { sts: "pending" },
    { iat: NOW + 1 },
    { nbf: NOW + 1 },
    { exp: NOW },
  ])("denies impersonation, pending or future session evidence %j", (overrides) => {
    expect(
      ConnectAuthentication.normalizeSessionAssurance({ ...claims, ...overrides }, NOW, 1),
    ).toBeNull();
  });
  it.effect("checks active session ownership and rejects a stale sensitive action", () =>
    Effect.gen(function* () {
      const { getSession } = setup();
      yield* TestClock.setTime(NOW * 1000);
      vi.mocked(verifyToken).mockResolvedValue(claims as never);
      const auth = yield* ConnectAuthentication.ConnectAuthentication;
      expect((yield* auth.session("session-token", true)).userId).toBe("user-1");
      getSession.mockResolvedValue({ status: "active", userId: "other-user" });
      expect((yield* auth.session("session-token").pipe(Effect.flip))._tag).toBe(
        "RelayAuthenticationStrengthError",
      );
      getSession.mockResolvedValue({ status: "active", userId: "user-1" });
      vi.mocked(verifyToken).mockResolvedValue({ ...claims, fva: [9, 9] } as never);
      expect(yield* auth.session("stale", true).pipe(Effect.flip)).toMatchObject({
        _tag: "RelayAuthenticationStrengthError",
        reason: "reauthentication_required",
      });
    }).pipe(run),
  );
  it.effect("does not issue on Clerk lookup failure or untrusted browser origin", () =>
    Effect.gen(function* () {
      const { getSession } = setup();
      yield* TestClock.setTime(NOW * 1000);
      vi.mocked(verifyToken).mockResolvedValue(claims as never);
      const auth = yield* ConnectAuthentication.ConnectAuthentication;
      getSession.mockRejectedValue(new Error("provider unavailable"));
      expect((yield* auth.session("session-token").pipe(Effect.flip))._tag).toBe(
        "RelayAuthenticationUnavailableError",
      );
      vi.mocked(verifyToken).mockResolvedValue({
        ...claims,
        azp: "https://sibling.example.test",
      } as never);
      expect((yield* auth.session("untrusted").pipe(Effect.flip))._tag).toBe(
        "RelayAuthInvalidError",
      );
    }).pipe(run),
  );
});

it.effect.each([
  { iss: "https://wrong.example.test" },
  { aud: "https://wrong-relay.example.test" },
  { azp: "https://staging.app.example.test" },
])("rejects a verified JWT from the wrong issuer, audience or party: %j", (override) =>
  Effect.gen(function* () {
    setup();
    yield* TestClock.setTime(NOW * 1000);
    vi.mocked(verifyToken).mockResolvedValue({ ...claims, ...override } as never);
    expect(
      (yield* (yield* ConnectAuthentication.ConnectAuthentication)
        .session("token")
        .pipe(Effect.flip))._tag,
    ).toBe("RelayAuthInvalidError");
  }).pipe(run),
);

it.effect.each(["pending", "revoked", "expired"])(
  "inactive Clerk session %s never issues authority",
  (status) =>
    Effect.gen(function* () {
      const { getSession } = setup();
      yield* TestClock.setTime(NOW * 1000);
      vi.mocked(verifyToken).mockResolvedValue(claims as never);
      getSession.mockResolvedValue({ status, userId: "user-1" });
      expect(
        (yield* (yield* ConnectAuthentication.ConnectAuthentication)
          .session("token")
          .pipe(Effect.flip))._tag,
      ).toBe("RelayAuthenticationStrengthError");
    }).pipe(run),
);

it.effect.each([
  { clientId: "wrong-client", scopes: ["openid", "profile", "email", "offline_access"] },
  { clientId: "cli-client", scopes: ["openid"] },
])("OAuth client/scope mismatch cannot authorize withdrawal: %j", (override) =>
  Effect.gen(function* () {
    setup();
    vi.mocked(createClerkClient).mockReturnValue({
      authenticateRequest: async () => ({
        isAuthenticated: true,
        toAuth: () => ({ tokenType: "oauth_token", userId: "user-1", ...override }),
      }),
    } as never);
    expect(
      (yield* (yield* ConnectAuthentication.ConnectAuthentication).oauth("oauth").pipe(Effect.flip))
        ._tag,
    ).toBe("RelayAuthInvalidError");
  }).pipe(run),
);

it.effect("a pending Clerk lookup times out closed without OAuth fallback", () =>
  Effect.gen(function* () {
    const { getSession } = setup();
    yield* TestClock.setTime(NOW * 1000);
    const started = promiseWithResolvers<void>();
    vi.mocked(verifyToken).mockResolvedValue(claims as never);
    const lookup = promiseWithResolvers<{ userId: string; status: string }>();
    getSession.mockImplementation(() => {
      started.resolve();
      return lookup.promise;
    });
    const auth = yield* ConnectAuthentication.ConnectAuthentication;
    const fiber = yield* auth.session("token").pipe(Effect.result, Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    yield* TestClock.adjust("10 seconds");
    const result = yield* Fiber.join(fiber);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure._tag).toBe("RelayAuthenticationUnavailableError");
    lookup.resolve({ userId: "user-1", status: "active" });
  }).pipe(run),
);
