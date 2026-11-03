import { assert, describe, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION, SshHostProviders } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SshTunnel from "./tunnel.ts";
import { ARCHIVE, uploadTarget } from "./tunnel.fixture.ts";
import { fixture, signals, stopped, successfulStatus } from "./tunnel.runtime-status.fixture.ts";

const decodeProviders = Schema.decodeEffect(SshHostProviders);
const live = (version: string) => ({
  ...stopped,
  ready: true,
  liveStatus: "live",
  liveVersion: version,
  livePort: 3773,
  liveOwned: true,
  liveDrain: true,
  liveSignals: signals(version),
  liveBinarySignals: signals(version),
});

describe("compatible SSH runtime", () => {
  it.effect("reconnects when a compatible unowned runtime moves ports", () => {
    const f = fixture({ ...live("1.2.2"), liveOwned: false });
    f.setLaunchVersion("1.2.2");
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      assert.equal(
        (yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true })).remotePort,
        3773,
      );
      f.setProbe({ ...live("1.2.2"), liveOwned: false, livePort: 3883 });
      f.setLaunchPort(3883);
      assert.equal(successfulStatus(yield* manager.status(uploadTarget)).state, "ready");
      yield* manager.readyEnvironment(uploadTarget).pipe(Effect.flip);
      assert.equal(
        (yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true })).remotePort,
        3883,
      );
      assert.equal((yield* manager.readyEnvironment(uploadTarget)).remotePort, 3883);
      assert.equal(f.calls.uploads, 0);
      assert.equal(f.calls.launches, 2);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });
  it.effect("a compatible unowned runtime remains usable after connecting and reconnecting", () => {
    const f = fixture({ ...live("1.2.2"), liveOwned: false });
    f.setLaunchVersion("1.2.2");
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const operation = yield* manager.beginSetupOperation(uploadTarget, "provider-detail");
      yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
      yield* manager.readyEnvironment(uploadTarget);
      const status = successfulStatus(yield* manager.status(uploadTarget));
      assert.equal(status.state, "ready");
      assert.include(status.detail ?? "", "didn't start or cannot replace");
      const providers = yield* decodeProviders({
        checkedAt: "2026-10-18T00:00:00.000Z",
        ready: false,
        fixes: [{ actor: "human", instruction: "Sign in." }],
      });
      yield* manager.publishProviderDiagnosis(uploadTarget, operation, providers);
      const diagnosed = successfulStatus(yield* manager.status(uploadTarget));
      assert.equal(diagnosed.state, "providers_not_ready");
      assert.include(diagnosed.detail ?? "", "didn't start or cannot replace");
      yield* manager.ensureEnvironment(uploadTarget, {
        keyOnly: true,
        reuseWhileRefreshPending: true,
      });
      assert.equal(f.calls.launches, 1);
      assert.equal(f.calls.uploads, 0);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("an owned older runtime without drain remains ready", () => {
    const f = fixture({ ...live("1.2.2"), liveDrain: false });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const status = successfulStatus(yield* manager.status(uploadTarget));
      assert.equal(status.state, "ready");
      assert.include(status.detail ?? "", "didn't start or cannot replace");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect.each([
    "missing binary",
    "wrong binary version",
    "incompatible binary",
    "incompatible live",
  ])("refuses unverified unowned runtime: %s", (kind) => {
    const version = "1.2.2";
    const probe = {
      ...live(version),
      liveOwned: false,
      ...(kind === "missing binary" ? { liveBinarySignals: undefined } : {}),
      ...(kind === "wrong binary version" ? { liveBinarySignals: signals("1.2.1") } : {}),
      ...(kind === "incompatible binary"
        ? {
            liveBinarySignals: {
              ...signals(version),
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1,
            },
          }
        : {}),
      ...(kind === "incompatible live"
        ? {
            liveSignals: {
              ...signals(version),
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1,
            },
          }
        : {}),
    };
    const f = fixture(probe);
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      assert.equal(successfulStatus(yield* manager.status(uploadTarget)).state, "update_blocked");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("a compatible unowned runtime without a launch identity stays ready", () => {
    const f = fixture({ ...live("1.2.2"), liveOwned: false, identityAbsent: true });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const status = successfulStatus(yield* manager.status(uploadTarget));
      assert.equal(status.state, "ready");
      assert.include(status.detail ?? "", "didn't start or cannot replace");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("an unowned requested runtime is ready without detail", () => {
    const f = fixture({ ...live(ARCHIVE.archiveVersion), liveOwned: false });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const status = successfulStatus(yield* manager.status(uploadTarget));
      assert.equal(status.state, "ready");
      assert.isUndefined(status.detail);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });
  it.effect("blocks a newer runtime only when it no longer speaks this app's protocol", () => {
    const f = fixture({
      ...stopped,
      liveStatus: "live",
      liveVersion: "99.0.0",
      liveOwned: true,
      liveDrain: true,
      liveSignals: {
        ...signals("99.0.0"),
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1,
      },
    });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const status = successfulStatus(yield* manager.status(uploadTarget));
      assert.equal(status.state, "update_blocked");
      assert.include(status.detail ?? "", "runs a newer GOAT (99.0.0)");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });
});
