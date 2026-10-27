import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type ChildReadyDeviceResult,
  type ChildReadyFailure,
  type ChildReadyNextAction,
  type ChildReadyResult,
  OpenCodexChildBootstrapStatus,
  OpenCodexChildSetup,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { presentSetupAction } from "./childBootstrapStatus.ts";
import { READY_CHECK_TTL_MS } from "./childReadyVerification.ts";
import * as ReadyDispatch from "./ChildReadyDispatch.ts";
import { build, commitHub, setup } from "./OpenCodexChildBootstrap.testkit.ts";

const decodeSetup = Schema.decodeUnknownSync(OpenCodexChildSetup);
const decodeRecords = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, OpenCodexChildBootstrapStatus)),
);
const setupForTest = (nextAction: ChildReadyNextAction, code: ChildReadyFailure["code"]) =>
  decodeSetup({
    version: 1,
    operationId: "r2-status",
    destinationEnvironmentId: "child",
    homeEnvironmentId: "home",
    instanceId: "r2-instance",
    revision: { epoch: "r2", sequence: 1 },
    steps: [],
    readiness: "invalid",
    attribution: "unproven",
    nextAction,
    failure: { code, step: "codex_installed", retryable: true, message: "original timeout detail" },
  });
const failure = (code: ChildReadyFailure["code"], retryable = false): ChildReadyFailure => ({
  code,
  step: "inference_verified",
  message: "The Child refused.",
  retryable,
});

/** A Home that linked this machine before Child setup existed: membership, no setup. */
const legacy = Effect.fn("OpenCodexChildBootstrapSetupTest.legacy")(function* (
  extraLinks: ReadonlyArray<{ readonly id: string; readonly alias: string }> = [],
) {
  const home = yield* setup({ extraLinks });
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    `${home.stateDir}/opencodex-child-bootstrap.json`,
    JSON.stringify({ "boat-builder": { state: "child", checkedAt: 1, version: "2.91.0" } }),
  );
  return { ...home, ...(yield* build(home.baseDir, home.machine, home.calls)) };
});

/** A Child protocol double for production dispatch that holds `action` until released. */
const transportDouble = (
  action: string,
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) =>
  ReadyDispatch.make({
    callHostTool: (call, beforeSend) =>
      Effect.gen(function* () {
        yield* beforeSend;
        const purpose = call.childSetupPurpose;
        if (purpose === undefined) return yield* Effect.die("Expected a setup purpose");
        const address = {
          destinationEnvironmentId: purpose.destinationEnvironmentId,
          homeEnvironmentId: purpose.homeEnvironmentId,
        };
        const requested =
          call.tool === "goat_hub_child_status" ? "status" : String(call.arguments.action);
        if (requested === action) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        if (requested === "status" || requested === "opencodexHealth")
          return {
            kind: "device",
            ...address,
            healthy: true,
            revision: { epoch: "r2", sequence: 1 },
            device: {
              platform: "linux",
              arch: "x64",
              ocx: { path: "/fixture/ocx", version: "2.92.0", ownership: "managed" },
              connection: { role: "client", linkId: "r2-link" },
            },
          } satisfies ChildReadyDeviceResult;
        if (["installCodex", "syncCatalog", "configure", "probe"].includes(requested))
          return {
            kind: "ok",
            setup: {
              ...setupForTest("none", "probe_failed"),
              ...address,
              operationId: purpose.operationId,
            },
          } satisfies ChildReadyResult;
        return {
          kind: "prelink",
          ...address,
          operationId: purpose.operationId,
          step: "opencodex_running",
          healthy: true,
          version: "2.92.0",
        } satisfies ChildReadyResult;
      }),
  });

it("keeps nested GOAT update guidance visible and non-actionable", () => {
  const status = presentSetupAction({
    state: "child",
    checkedAt: 0,
    setup: setupForTest("update_goat", "attribution_unproven"),
  });
  expect(status.nextAction).toBe("update_goat");
  expect(status.actionable).toBe(false);
});

it.each(["purpose_expired", "phase_timeout"] as const)(
  "shows the setup timeout label and retry action for %s",
  (code) => {
    const status = presentSetupAction({
      state: "child",
      checkedAt: 0,
      setup: setupForTest("retry", code),
    });
    expect(status.reason).toBe("setup_step_timeout");
    expect(status.setup?.failure?.message).toBe("A setup step timed out. Retry setup.");
    expect(status.nextAction).toBe("retry");
    expect(status.actionable).toBe(true);
  },
);

it.layer(NodeServices.layer)("OpenCodex Child setup from the Home", (it) => {
  it.effect("finishes Child Codex setup after linking", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      const status = yield* home.bootstrap.ensure("boat-builder");
      expect(status).toMatchObject({ state: "child", setup: { readiness: "ready" } });
      expect(home.calls).toEqual(["prepare boat-builder 2.91.0", "join boat-builder"]);
      expect(home.machine.completed).toEqual(["boat-builder r2-link"]);
    }),
  );

  it.effect("preserves linked status when inference fails", () =>
    Effect.gen(function* () {
      const home = yield* setup({ completeFailure: failure("probe_failed", true) });
      expect(yield* home.bootstrap.ensure("boat-builder")).toMatchObject({
        state: "child",
        failure: { code: "probe_failed" },
        nextAction: "retry",
        actionable: true,
      });
    }),
  );

  it.effect("offers Continue setup for a legacy linked Child without running setup on read", () =>
    Effect.gen(function* () {
      const home = yield* legacy();
      expect(yield* home.bootstrap.status("boat-builder")).toMatchObject({
        state: "child",
        nextAction: "continue_setup",
        actionable: true,
      });
      expect(home.calls).toEqual([]);
    }),
  );

  it.effect("completes an explicitly continued legacy Child without relinking", () =>
    Effect.gen(function* () {
      const home = yield* legacy([{ id: "legacy-link", alias: "boat-builder" }]);
      const result = yield* home.bootstrap.setupDevice({ deviceAlias: "boat-builder" });
      expect(result).toMatchObject({ kind: "ok", setup: { readiness: "ready" } });
      expect(home.calls).toEqual([]);
      expect(home.machine.completed).toEqual(["boat-builder legacy-link"]);
    }),
  );

  it.effect("shows GOAT update guidance only after a real remote_outdated refusal", () =>
    Effect.gen(function* () {
      const home = yield* setup({ completeFailure: failure("remote_outdated") });
      yield* home.bootstrap.ensure("boat-builder");
      expect(yield* home.bootstrap.status("boat-builder")).toMatchObject({
        state: "child",
        nextAction: "update_goat",
        actionable: false,
      });
    }),
  );

  it.effect("explicit setup without standing consent runs nothing and gives no consent", () =>
    Effect.gen(function* () {
      const home = yield* setup();
      const result = yield* home.bootstrap.setupDevice({ deviceAlias: "lidge-ts" });
      expect(result).toMatchObject({ kind: "error", failure: { code: "setup_approval_revoked" } });
      expect(home.calls).toEqual([]);
      expect(yield* home.bootstrap.sshOptIn("lidge-ts")).toBe(false);
    }),
  );

  it.effect("does not report Ready when Home status persistence fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* setup().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
              }),
            ),
        }),
      );
      const status = yield* home.bootstrap.ensure("boat-builder");
      expect(status?.failure?.code).toBe("storage_failed");
      expect(status?.setup?.proof).toBeUndefined();
      expect(status?.setup?.readiness).not.toBe("ready");
    }),
  );

  it.effect.each([
    ["installCodex", "codex_installed"],
    ["syncCatalog", "instance_routed"],
    ["configure", "instance_routed"],
    ["probe", "inference_verified"],
  ] as const)(
    "records %s's step %s after approval is revoked there, keeping membership",
    ([action, step]) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const ready = transportDouble(action, entered, release);
        const home = yield* setup({ readyDispatch: ready });
        const pending = yield* Effect.forkChild(home.bootstrap.ensure("boat-builder"));
        yield* Deferred.await(entered);
        home.machine.autoJoin = false;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending);
        const fs = yield* FileSystem.FileSystem;
        const saved = decodeRecords(
          yield* fs.readFileString(`${home.stateDir}/opencodex-child-bootstrap.json`),
        );
        expect(saved["boat-builder"]?.state).toBe("child");
        expect(saved["boat-builder"]?.failure?.code).toBe("setup_approval_revoked");
        expect(saved["boat-builder"]?.failure?.step).toBe(step);
        expect(saved["boat-builder"]?.step).toBe(step);
        expect(saved["boat-builder"]?.setup?.readiness).not.toBe("ready");
      }),
  );

  it.effect("turning the cloud switch off then on revokes and fails an in-flight Child setup", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      const home = yield* setup({
        readyDispatch: transportDouble("configure", entered, release),
        onRevoke: () => Deferred.succeed(revoked, undefined).pipe(Effect.asVoid),
      });
      const pending = yield* Effect.forkChild(home.bootstrap.ensure("boat-builder"));
      yield* Deferred.await(entered);
      const off = yield* commitHub(home.machine, { autoJoin: false });
      yield* PubSub.publish(home.machine.settingsChanges, off);
      // Withdrawal revokes the delegated Child sessions at once.
      yield* Deferred.await(revoked);
      yield* PubSub.publish(
        home.machine.settingsChanges,
        yield* commitHub(home.machine, { autoJoin: true }),
      );
      yield* Deferred.succeed(release, undefined);
      const status = yield* Fiber.join(pending);
      expect(status?.setup?.readiness).not.toBe("ready");
      expect(["setup_approval_revoked", "setup_approval_stale"]).toContain(status?.failure?.code);
    }),
  );

  it.effect(
    "an off-then-on commit fails an in-flight reply while the settings subscriber is held",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const home = yield* setup({
          readyDispatch: transportDouble("configure", entered, release),
          // The subscriber never runs during this test, as when it waits on secrets or SSH.
          deliverChanges: yield* Deferred.make<void>(),
        });
        const pending = yield* Effect.forkChild(home.bootstrap.ensure("boat-builder"));
        yield* Deferred.await(entered);
        yield* PubSub.publish(
          home.machine.settingsChanges,
          yield* commitHub(home.machine, { autoJoin: false }),
        );
        yield* PubSub.publish(
          home.machine.settingsChanges,
          yield* commitHub(home.machine, { autoJoin: true }),
        );
        yield* Deferred.succeed(release, undefined);
        const status = yield* Fiber.join(pending);
        expect(status?.failure?.code).toBe("setup_approval_stale");
        expect(status?.setup?.readiness).not.toBe("ready");
      }),
  );

  it.effect("shows Ready only while a fresh Child status confirms the recorded proof", () =>
    Effect.gen(function* () {
      const statusRevoked = yield* Deferred.make<string>();
      let setupDone = false;
      const home = yield* setup({
        readyProof: true,
        onRevoke: (binding) =>
          setupDone
            ? Deferred.succeed(statusRevoked, binding.operationId).pipe(Effect.asVoid)
            : Effect.void,
      });
      yield* home.bootstrap.ensure("boat-builder");
      setupDone = true;
      expect(yield* home.bootstrap.status("boat-builder")).toMatchObject({
        setup: { readiness: "ready", proof: { linkId: "r2-link" } },
      });
      // The status read's own short session is revoked after it, not the setup operation's.
      expect(yield* Deferred.await(statusRevoked)).not.toBe(home.machine.childSetup?.operationId);
      // A confirmation stands briefly: a second read asks the Child nothing.
      yield* home.bootstrap.status("boat-builder");
      expect(home.machine.statusReads).toBe(1);
      // The Child's own validation now fails, as when its Codex release was replaced.
      const childSetup = home.machine.childSetup;
      if (childSetup === undefined) return yield* Effect.die("Expected the Child's setup");
      const { proof: _proof, ...withoutProof } = childSetup;
      home.machine.childSetup = {
        ...withoutProof,
        readiness: "invalid",
        failure: failure("route_unverified", true),
      };
      yield* TestClock.adjust(READY_CHECK_TTL_MS);
      const after = yield* home.bootstrap.status("boat-builder");
      expect(home.machine.statusReads).toBe(2);
      expect(after?.setup?.readiness).toBe("linked");
      expect(after?.setup?.proof).toBeUndefined();
      expect(after?.setup?.failure?.code).toBe("route_unverified");
      expect(after).toMatchObject({ state: "child", nextAction: "retry", actionable: true });
    }),
  );

  it.effect("shows an unreachable Child as linked and unverified, never Ready", () =>
    Effect.gen(function* () {
      const home = yield* setup({ readyProof: true });
      yield* home.bootstrap.ensure("boat-builder");
      home.machine.statusFailure = {
        code: "unreachable",
        step: "link_established",
        message: "The Child did not answer the setup request.",
        retryable: true,
      };
      const status = yield* home.bootstrap.status("boat-builder");
      expect(status?.setup?.readiness).toBe("linked");
      expect(status?.setup?.attribution).toBe("unproven");
      expect(status?.setup?.proof).toBeUndefined();
      expect(status?.setup?.failure?.code).toBe("unreachable");
    }),
  );

  it.effect("shows a recorded Ready whose older proof no longer decodes as unverified", () =>
    Effect.gen(function* () {
      const home = yield* setup({ readyProof: true });
      const fs = yield* FileSystem.FileSystem;
      const ready = {
        ...setupForTest("none", "probe_failed"),
        readiness: "ready",
        attribution: "home_zero_local_accounts",
        failure: undefined,
        // A proof from before link continuity was bound: it has no connection generation.
        proof: {
          version: 1,
          operationId: "r2-status",
          destinationEnvironmentId: "child",
          homeEnvironmentId: "home",
          instanceId: "r2-instance",
          configFingerprint: "config",
          executablePath: "/fixture/codex",
          executableVersion: "0.156.0",
          linkId: "r2-link",
          listenerInstanceId: "listener",
          settingsDigest: "settings",
          catalogDigest: "catalog",
          model: "fixture-model",
          completedAt: 0,
          expiresAt: 24 * 60 * 60 * 1000,
          attribution: "home_zero_local_accounts",
          localAccountsDigest: "zero-local",
        },
      };
      yield* fs.writeFileString(
        `${home.stateDir}/opencodex-child-bootstrap.json`,
        JSON.stringify({ "boat-builder": { state: "child", checkedAt: 1, setup: ready } }),
      );
      const reloaded = yield* build(home.baseDir, home.machine, home.calls);
      const status = yield* reloaded.bootstrap.status("boat-builder");
      expect(status?.setup?.proof).toBeUndefined();
      expect(status?.setup).toMatchObject({ readiness: "linked", attribution: "unproven" });
      expect(status).toMatchObject({ nextAction: "retry", actionable: true });
      expect(home.machine.statusReads).toBe(0);
    }),
  );
});
