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
import * as Schema from "effect/Schema";

import { presentSetupAction } from "./childBootstrapStatus.ts";
import * as ReadyDispatch from "./ChildReadyDispatch.ts";
import { build, setup } from "./OpenCodexChildBootstrap.testkit.ts";

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
        const ready = ReadyDispatch.make({
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
});
