import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ConnectionBlockedError, ConnectionTransientError } from "@goat/client-runtime/connection";

import {
  desktopOwnsSshHostConfig,
  readDesktopSshRuntime,
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  isRejectedBootstrapCredentialError,
  isRejectedSecondaryBootstrap,
  nextRejectedSecondaryBootstrap,
  primaryRegistrationToRetainAfterTopologyRead,
  prepareDesktopSshEnvironment,
  provisionDesktopSshEnvironment,
  readPrimaryEnvironmentTargetResult,
  secondaryRegistrationsToRetainAfterTopologyRead,
  secondaryBearerExpiresAtEpochMs,
  secondaryBearerRefreshAtEpochMs,
  secondsUntil,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

function makeBridge(
  calls: string[],
  options?: { readonly failDescriptor?: boolean },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (target: DesktopSshEnvironmentTarget) => {
      calls.push("ensure");
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: "pairing-token",
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

describe("desktop SSH pairing", () => {
  it.effect("forwards key-only authentication to the desktop bridge", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const bridge = makeBridge(calls);
      const ensure = bridge.ensureSshEnvironment;
      let received: Parameters<DesktopBridge["ensureSshEnvironment"]>[1];
      bridge.ensureSshEnvironment = (target, options) => {
        received = options;
        return ensure(target, options);
      };
      yield* provisionDesktopSshEnvironment(bridge, TARGET, undefined, { keyOnly: true });
      expect(received).toEqual({ issuePairingToken: true, keyOnly: true });
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );
  it.effect("fetches the descriptor before consuming the one-time credential", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const provisioned = yield* provisionDesktopSshEnvironment(makeBridge(calls), TARGET);

      expect(provisioned.environmentId).toBe(EnvironmentId.make("environment-ssh"));
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("does not consume the credential when adding a route to a different machine", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const error = yield* provisionDesktopSshEnvironment(
        makeBridge(calls),
        TARGET,
        EnvironmentId.make("some-other-machine"),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect("does not consume the credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failDescriptor: true }),
        TARGET,
      ).pipe(Effect.flip);

      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("refreshes a secondary bearer before it expires", () => {
    const issuedAtEpochMs = 10_000;
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, 60);
    const expiresAtEpochMs = secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, 60);
    const cached = {
      expiresAtEpochMs,
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(65_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 64_999)).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 65_000)).toBe(false);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 69_999),
    ).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 70_000),
    ).toBe(false);
  });

  it("caches a desktop-issued bearer until just before its own expiry", () => {
    const now = Date.parse("2026-10-12T10:00:00.000Z");
    const expiresIn = secondsUntil("2026-10-12T10:01:00.000Z", now);
    expect(expiresIn).toBe(60);
    expect(secondaryBearerRefreshAtEpochMs(now, expiresIn)).toBe(now + 55_000);
    // An unreadable or past expiry is never cached, so the next poll asks again.
    expect(secondsUntil(undefined, now)).toBe(0);
    expect(secondsUntil("not a date", now)).toBe(0);
    expect(secondsUntil("2026-10-12T09:00:00.000Z", now)).toBe(0);
  });

  it("does not cache credentials whose lifetime is shorter than the refresh skew", () => {
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(10_000, 3);
    const cached = {
      expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(10_000, 3),
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(10_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 10_000)).toBe(false);
  });

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("rejected desktop-local bootstrap tokens", () => {
  it("backs off on a rejected signature and retries it on a growing, capped delay", () => {
    const signature = "http://a|ws://a|old-token";
    const first = nextRejectedSecondaryBootstrap(undefined, signature, 0);

    expect(isRejectedSecondaryBootstrap(first, signature, 59_999)).toBe(true);
    // A backend restarted on the same port accepts the same token again, so it is retried.
    expect(isRejectedSecondaryBootstrap(first, signature, 60_000)).toBe(false);

    const second = nextRejectedSecondaryBootstrap(first, signature, 60_000);
    expect(second.retryAtEpochMs).toBe(180_000);

    let backoff = second;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      backoff = nextRejectedSecondaryBootstrap(backoff, signature, 0);
    }
    expect(backoff.delayMs).toBe(30 * 60_000);
  });

  it("retries at once when the token or endpoint changes", () => {
    const rejected = nextRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 0);

    expect(isRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(rejected, "http://b|ws://b|old-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 1)).toBe(false);
    expect(nextRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1).delayMs).toBe(
      60_000,
    );
  });

  it("treats only authentication rejections as a dead credential", () => {
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionBlockedError({ reason: "authentication", detail: "invalid" }),
      ),
    ).toBe(true);
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionTransientError({ reason: "endpoint-unavailable", detail: "booting" }),
      ),
    ).toBe(false);
  });
});

describe("desktop-local bearer cache across token changes", () => {
  it("keeps a live bearer when only the bootstrap token rotates", () => {
    // Cached by endpoint: a rotated token reuses the bearer instead of
    // dropping the environment (and its drafts) when the new token is rejected.
    const cached = {
      signature: "http://a|ws://a",
      registration: {} as never,
      expiresAtEpochMs: 20_000,
      refreshAtEpochMs: 15_000,
    };

    expect(canReuseCachedPlatformRegistration(cached, "http://a|ws://a", 10_000)).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, "http://a|ws://a", 16_000),
    ).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, "http://b|ws://b", 10_000)).toBe(false);
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });
});

describe("cloud machine SSH preflight", () => {
  const CLOUD: DesktopSshEnvironmentTarget = {
    alias: "boat-bx_23456789",
    hostname: "203.0.113.10",
    username: "user",
    port: 22,
  };
  const ready = (calls: string[], failure?: ConnectionBlockedError) => (alias: string) =>
    Effect.sync(() => void calls.push(`ready:${alias}`)).pipe(
      Effect.andThen(failure === undefined ? Effect.void : Effect.fail(failure)),
    );

  it.effect("readies a cloud machine through its server before the desktop dials it", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* provisionDesktopSshEnvironment(
        makeBridge(calls),
        CLOUD,
        undefined,
        undefined,
        ready(calls),
      );
      yield* prepareDesktopSshEnvironment(makeBridge(calls), CLOUD, ready(calls));
      expect(calls).toEqual([
        "ready:boat-bx_23456789",
        "ensure",
        "descriptor",
        "token",
        "ready:boat-bx_23456789",
        "ensure",
        "token",
      ]);
    }),
  );

  it.effect("never dials a cloud machine its server could not ready", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const stopped = new ConnectionBlockedError({ reason: "configuration", detail: "stopped" });
      const error = yield* prepareDesktopSshEnvironment(
        makeBridge(calls),
        CLOUD,
        ready(calls, stopped),
      ).pipe(Effect.flip);
      expect(error).toBe(stopped);
      expect(calls).toEqual(["ready:boat-bx_23456789"]);
    }),
  );

  it.effect("leaves ordinary SSH hosts alone", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* prepareDesktopSshEnvironment(makeBridge(calls), TARGET, ready(calls));
      expect(calls).toEqual(["ensure", "token"]);
    }),
  );
});

describe("managed SSH host trust boundary", () => {
  it("only allows the native primary backend belonging to this Desktop", () => {
    const primary = {
      id: PRIMARY_LOCAL_ENVIRONMENT_ID,
      label: "This machine",
      httpBaseUrl: "http://127.0.0.1:3000",
      wsBaseUrl: "ws://127.0.0.1:3000",
      bootstrapToken: "local-bootstrap",
    };
    const bridge = { getLocalEnvironmentBootstraps: () => [primary] };
    expect(desktopOwnsSshHostConfig(bridge, primary.httpBaseUrl)).toBe(true);
    expect(desktopOwnsSshHostConfig(undefined, primary.httpBaseUrl)).toBe(false);
    expect(desktopOwnsSshHostConfig(bridge, "https://remote.test")).toBe(false);
    expect(
      desktopOwnsSshHostConfig(
        { getLocalEnvironmentBootstraps: () => [{ ...primary, runningDistro: "Ubuntu" }] },
        primary.httpBaseUrl,
      ),
    ).toBe(false);
    expect(
      desktopOwnsSshHostConfig(
        { getLocalEnvironmentBootstraps: () => [{ ...primary, bootstrapToken: "" }] },
        primary.httpBaseUrl,
      ),
    ).toBe(false);
  });
  it.effect(
    "enforces key-only for managed hosts even when a caller requests password prompts",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const bridge = makeBridge(calls);
        const ensure = bridge.ensureSshEnvironment;
        let options: Parameters<DesktopBridge["ensureSshEnvironment"]>[1];
        bridge.ensureSshEnvironment = (target, input) => {
          options = input;
          return ensure(target, input);
        };
        yield* provisionDesktopSshEnvironment(bridge, { ...TARGET, alias: "goat-box" }, undefined, {
          keyOnly: false,
        });
        expect(options).toEqual({ issuePairingToken: true, keyOnly: true });
      }),
  );
  it.effect.each(["2001:db8::1", "host-" + "a".repeat(100)])(
    "decodes the Desktop owner's unrestricted hostname %s",
    (hostname) =>
      Effect.gen(function* () {
        const status = {
          host: hostname,
          state: "auth_failed" as const,
          runtimeVersion: null,
          requestedVersion: "0.4.2",
          publicKey: "ssh-ed25519 public-test-key",
        };
        const result = yield* readDesktopSshRuntime(
          {
            getSshHostStatus: async () => ({ kind: "ok", status }),
            updateSshRuntime: async () => ({ kind: "ok", status }),
          },
          { ...TARGET, hostname, alias: hostname },
        );
        if (result.kind !== "ok") throw new Error("Expected decoded owner status");
        expect(result.status.host).toBe(hostname);
        expect(result.status.publicKey).toBe(status.publicKey);
      }),
  );
  it.effect("rejects malformed IPC success envelopes with a useful retry instruction", () =>
    Effect.gen(function* () {
      const malformed = {
        getSshHostStatus: async () => ({ kind: "ok", status: { host: "box", state: "preparing" } }),
      } as unknown as Pick<DesktopBridge, "getSshHostStatus" | "updateSshRuntime">;
      expect(yield* readDesktopSshRuntime(malformed, TARGET)).toEqual({
        kind: "error",
        code: "operation_failed",
        message: "Could not read or update GOAT on devbox. Try again.",
        fix: { actor: "human", instruction: "Try again" },
      });
    }),
  );
});
