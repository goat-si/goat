import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createClerkClient, verifyToken } from "@clerk/backend";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectAuthentication from "./ConnectAuthentication.ts";
import * as RelayConfiguration from "../Config.ts";

vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn(), verifyToken: vi.fn() }));
const NOW = 1800000000;
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
    Effect.provideService(RelayConfiguration.RelayConfiguration, config),
  );

describe("Connect session assurance", () => {
  it("keeps conservative original factor times as a token travels or is refreshed", () => {
    const first = ConnectAuthentication.normalizeSessionAssurance(claims, NOW + 30);
    expect(first?.firstVerifiedAtFloor).toBe(NOW - 60);
    const refreshed = ConnectAuthentication.normalizeSessionAssurance(
      { ...claims, iat: NOW + 60, exp: NOW + 120, fva: [1, 1] },
      NOW + 60,
    );
    expect(refreshed?.firstVerifiedAtFloor).toBe(first?.firstVerifiedAtFloor);
  });
  it.each([undefined, [0, -1], [-1, 0], [0], [0, 0, 0], [0, 1.5], [0, Number.MAX_SAFE_INTEGER]])(
    "denies missing or unsupported factor ages %j",
    (fva) => {
      expect(ConnectAuthentication.normalizeSessionAssurance({ ...claims, fva }, NOW)).toBeNull();
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
      ConnectAuthentication.normalizeSessionAssurance({ ...claims, ...overrides }, NOW),
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
      expect((yield* auth.session("stale", true).pipe(Effect.flip)).reason).toBe(
        "reauthentication_required",
      );
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
        "RelayInternalError",
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
