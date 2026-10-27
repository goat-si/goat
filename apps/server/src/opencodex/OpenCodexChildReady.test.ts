import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ServerSettingsError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { type ChildState, failureCode, fixture, home } from "./OpenCodexChildReady.testkit.ts";

it.layer(NodeServices.layer)("OpenCodexChildReady", (it) => {
  it.effect("installs and checks OpenCodex before any Child link exists", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ role: "standalone" });
      const installed = yield* f.call("installOpenCodex");
      expect(installed).toMatchObject({ kind: "prelink", version: "2.92.0", healthy: true });
      const device = yield* f.call("opencodexHealth");
      expect(device).toMatchObject({
        kind: "device",
        device: { connection: { role: "standalone" } },
      });
      // Post-link stages refuse until joined.
      expect(failureCode(yield* f.call("installCodex"))).toBe("link_changed");
    }),
  );

  it.effect.each([
    ["busy", "installation_failed"],
    ["download", "installation_failed"],
    ["verify", "installation_failed"],
    ["shadowed", "ocx_unusable"],
    ["not-managed", "ocx_unusable"],
    ["unsupported", "platform_unsupported"],
  ] as const)("maps an OpenCodex install %s failure to %s", ([reason, code]) =>
    Effect.gen(function* () {
      const f = yield* fixture({ installFailure: reason, role: "standalone" });
      expect(failureCode(yield* f.call("installOpenCodex"))).toBe(code);
    }),
  );

  it.effect("represents a missing executable with null path and version", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ binary: undefined, role: "standalone" });
      expect(yield* f.status).toMatchObject({
        kind: "device",
        healthy: false,
        device: { ocx: { path: null, version: null, ownership: "missing" } },
      });
    }),
  );

  it.effect(
    "creates one managed auth-none Codex instance without reading provider credentials",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        expect(yield* f.routed).toBeUndefined();
        expect(yield* f.storedInstance).toMatchObject({
          driver: "codex",
          enabled: true,
          config: { setupMode: "managed", modelRoute: "opencodex", opencodexAuth: "none" },
        });
      }),
  );

  it.effect("installs GOAT's managed release on a Child whose PATH already has Codex", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ managedCodex: false });
      expect((yield* f.call("installCodex")).kind).toBe("ok");
      expect(f.resolveCalls.length).toBeGreaterThan(0);
      expect(f.resolveCalls.every((managedOnly) => managedOnly === true)).toBe(true);
    }),
  );

  it.effect("joins an existing installer and refuses failed installation without login", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ managedCodex: false, installResult: "failed" });
      expect(failureCode(yield* f.call("installCodex"))).toBe("installation_failed");
    }),
  );

  it.effect("does not overwrite an unowned deterministic instance", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.seedInstance;
      expect(failureCode(yield* f.call("installCodex"))).toBe("instance_changed");
      expect(yield* f.storedInstance).toMatchObject({ displayName: "Mine" });
    }),
  );

  it.effect("rejects a revision that changes while the settings commit waits for its lock", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = yield* fixture({
        commit: (write) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(write),
          ),
      });
      expect((yield* f.call("installCodex")).kind).toBe("ok");
      expect((yield* f.call("syncCatalog")).kind).toBe("ok");
      const pending = yield* Effect.forkChild(f.call("configure"));
      yield* Deferred.await(entered);
      // A concurrent settings change lands after configure's own check, before the commit's.
      f.state.revision = { ...f.state.revision, sequence: f.state.revision.sequence + 1 };
      yield* Deferred.succeed(release, undefined);
      expect(failureCode(yield* Fiber.join(pending))).toBe("stale_configuration");
      expect(yield* f.storedInstance).toBeUndefined();
    }),
  );

  it.effect("adopts the exact committed instance after the ownership record was lost", () =>
    Effect.gen(function* () {
      let crashAfterCommit = true;
      const f = yield* fixture({
        commit: (write) =>
          write.pipe(
            Effect.filterOrFail(
              () => !crashAfterCommit,
              () => new ServerSettingsError({ settingsPath: "<test>", operation: "normalize" }),
            ),
          ),
      });
      yield* f.call("installCodex");
      yield* f.call("syncCatalog");
      // The settings commit lands but its answer is lost, as a crash before the journal would.
      expect((yield* f.call("configure")).kind).toBe("error");
      expect(yield* f.storedInstance).toBeDefined();
      crashAfterCommit = false;
      expect((yield* f.call("configure")).kind).toBe("ok");
      expect((yield* f.call("probe")).kind).toBe("ok");
    }),
  );

  it.effect("refuses to recreate a bootstrap instance the user deleted", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      yield* f.removeInstance;
      expect(failureCode(yield* f.call("installCodex"))).toBe("instance_changed");
      expect(failureCode(yield* f.call("configure"))).toBe("instance_changed");
      expect(yield* f.storedInstance).toBeUndefined();
    }),
  );

  it.effect("reuses a recorded proof for the same operation without another request", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      expect((yield* f.call("probe")).kind).toBe("ok");
      expect(yield* f.call("probe")).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
      expect(yield* f.probes).toBe(1);
    }),
  );

  it.effect("never repeats a request whose outcome was not recorded", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      const operation = yield* f.journal.read(home);
      if (operation === undefined) return yield* Effect.die("Expected a setup operation");
      // A request began and this process stopped before recording how it ended.
      yield* f.journal.put(home, { ...operation, probeStarted: true });
      expect(failureCode(yield* f.call("probe"))).toBe("interrupted");
      expect(yield* f.probes).toBe(0);
    }),
  );

  it.effect.each([
    [
      "the managed Codex release",
      (state: ChildState): void => void (state.codexVersion = "0.157.0"),
    ],
    [
      "the Home settings digest",
      (state: ChildState): void => void (state.settingsDigest = "other"),
    ],
  ] as const)("invalidates stored proof when %s changes", ([, change]) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      yield* f.call("probe");
      change(f.state);
      expect(yield* f.status).toMatchObject({
        setup: { readiness: "invalid", failure: { code: "route_unverified" } },
      });
    }),
  );

  it.effect("withholds proof when the Home settings change during the request", () =>
    Effect.gen(function* () {
      const f = yield* fixture({}, (state) => {
        state.settingsDigest = "changed-mid-request";
      });
      yield* f.routed;
      expect(failureCode(yield* f.call("probe"))).toBe("route_unverified");
    }),
  );

  it.effect("withholds Home attribution when local accounts exist", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ localCredentials: { count: 1, generation: "gen-1" } });
      yield* f.routed;
      expect(failureCode(yield* f.call("probe"))).toBe("attribution_unproven");
      expect(yield* f.probes).toBe(0);
    }),
  );

  it.effect("offers an OpenCodex update hint when localCredentials is absent", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ localCredentials: undefined });
      yield* f.routed;
      const result = yield* f.call("probe");
      expect(result).toMatchObject({
        kind: "error",
        failure: {
          code: "attribution_unproven",
          message: expect.stringContaining("Update OpenCodex"),
        },
      });
      expect(yield* f.probes).toBe(0);
    }),
  );

  it.effect("requires zero localCredentials and equal generation before and after inference", () =>
    Effect.gen(function* () {
      const f = yield* fixture({}, (state) => {
        state.localCredentials = { count: 0, generation: "gen-2" };
      });
      yield* f.routed;
      expect(failureCode(yield* f.call("probe"))).toBe("attribution_unproven");
      expect(yield* f.probes).toBe(1);
      expect(yield* f.status).toMatchObject({ setup: { readiness: "invalid" } });
    }),
  );

  it.effect("discards completion when the Child link drops mid-probe", () =>
    Effect.gen(function* () {
      const f = yield* fixture({}, (state) => {
        state.role = "standalone";
      });
      yield* f.routed;
      expect(failureCode(yield* f.call("probe"))).toBe("link_changed");
    }),
  );

  it.effect("withholds proof when the link reconnects during the request with the same ids", () =>
    Effect.gen(function* () {
      const f = yield* fixture({}, (state) => {
        state.connectionGeneration = "connection-2";
      });
      yield* f.routed;
      expect(failureCode(yield* f.call("probe"))).toBe("link_changed");
      expect(yield* f.status).not.toMatchObject({ setup: { readiness: "ready" } });
    }),
  );

  it.effect("invalidates stored proof after the link reconnects with the same ids", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      expect(yield* f.call("probe")).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
      f.state.connectionGeneration = "connection-2";
      expect(yield* f.status).toMatchObject({
        device: { connection: { role: "client", linkId: "link-1" } },
        setup: { readiness: "invalid", failure: { code: "link_changed" } },
      });
    }),
  );

  it.effect("offers an OpenCodex update hint when no link connection generation is reported", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ connectionGeneration: undefined });
      yield* f.routed;
      expect(yield* f.call("probe")).toMatchObject({
        kind: "error",
        failure: {
          code: "attribution_unproven",
          message: expect.stringContaining("Update OpenCodex"),
        },
      });
      expect(yield* f.probes).toBe(0);
    }),
  );

  it.effect("expires Ready at 24h without another inference", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      const proved = yield* f.call("probe");
      expect(proved).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
      expect(yield* f.status).toMatchObject({ setup: { readiness: "ready" } });
      yield* TestClock.adjust("24 hours");
      expect(yield* f.status).toMatchObject({
        setup: { readiness: "invalid", failure: { code: "proof_expired" } },
      });
      expect(yield* f.probes).toBe(1);
    }),
  );

  it.effect("retains membership but invalidates proof after a link change", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      yield* f.call("probe");
      f.state.linkId = "link-2";
      expect(yield* f.status).toMatchObject({
        device: { connection: { role: "client", linkId: "link-2" } },
        setup: { readiness: "invalid", failure: { code: "link_changed" } },
      });
    }),
  );

  it.effect("rejects a revoked destination setup purpose before changing settings", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ revoked: true });
      expect(failureCode(yield* f.call("installCodex"))).toBe("setup_approval_revoked");
      expect(yield* f.storedInstance).toBeUndefined();
    }),
  );

  it.effect("a refused address or a stale operation leaves the recorded proof untouched", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.routed;
      expect(yield* f.call("probe")).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
      // A purpose for another Home naming this Home's address is refused and writes nothing.
      f.state.purposeHome = EnvironmentId.make("home-b");
      expect(failureCode(yield* f.call("configure"))).toBe("destination_changed");
      f.state.purposeHome = home;
      // An older operation's failing request cannot invalidate the current one.
      const stale = { ...f.state.revision, sequence: f.state.revision.sequence - 1 };
      expect(failureCode(yield* f.call("configure", stale, "op-old"))).toBe("stale_configuration");
      expect(yield* f.status).toMatchObject({ setup: { readiness: "ready" } });
    }),
  );
});
