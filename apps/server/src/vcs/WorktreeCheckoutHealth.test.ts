import { defenderExclusionCommand } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorktreeCheckoutHealth from "./WorktreeCheckoutHealth.ts";
import { assessWorktreeScanStatus, parseDefenderProbe } from "./WorktreeCheckoutHealth.ts";

const WORKTREES = "C:\\Users\\super\\.goat\\worktrees";

const probe = (overrides: Partial<Record<string, unknown>> = {}) =>
  parseDefenderProbe(
    JSON.stringify({
      realTimeProtection: true,
      runningMode: "Normal",
      exclusions: "",
      fileSystem: "NTFS",
      ...overrides,
    }),
  );

describe("assessWorktreeScanStatus", () => {
  it("flags real-time scanning of an NTFS worktree folder, as measured on mini", () => {
    // Verbatim probe output from mini (Windows 11, Defender on, no exclusions).
    const mini =
      '{"realTimeProtection":true,"runningMode":"Normal","exclusions":"","fileSystem":"NTFS"}';
    assert.equal(assessWorktreeScanStatus(parseDefenderProbe(mini), WORKTREES), "scanning");
    assert.equal(assessWorktreeScanStatus(probe(), WORKTREES), "scanning");
    assert.equal(
      assessWorktreeScanStatus(probe({ exclusions: "D:\\builds" }), WORKTREES),
      "scanning",
    );
    // A sibling whose name only starts the same way is not an exclusion of this folder.
    assert.equal(
      assessWorktreeScanStatus(
        probe({ exclusions: "D:\\builds|C:\\Users\\super\\.goat\\work" }),
        WORKTREES,
      ),
      "scanning",
    );
  });

  it("recognizes an exclusion of the folder or a parent, whatever its case and slashes", () => {
    for (const exclusion of [
      "C:\\Users\\super\\.goat\\worktrees",
      "c:/users/SUPER/.goat/",
      "C:\\Users\\super",
    ]) {
      assert.equal(
        assessWorktreeScanStatus(probe({ exclusions: exclusion }), WORKTREES),
        "excluded",
        exclusion,
      );
    }
  });

  it("cannot confirm an exclusion without administrator rights", () => {
    assert.equal(
      assessWorktreeScanStatus(
        probe({ exclusions: "N/A: Must be an administrator to view exclusions" }),
        WORKTREES,
      ),
      "unverified",
    );
    assert.equal(assessWorktreeScanStatus(probe({ exclusions: null }), WORKTREES), "unverified");
  });

  it("leaves possible Dev Drives, disabled protection and other antivirus alone", () => {
    // Whether a ReFS volume is a trusted Dev Drive is not readable, so it is not flagged.
    assert.equal(
      assessWorktreeScanStatus(probe({ fileSystem: "ReFS" }), "D:\\worktrees"),
      "unknown",
    );
    assert.equal(
      assessWorktreeScanStatus(
        probe({ fileSystem: "ReFS", exclusions: "D:\\worktrees" }),
        "D:\\worktrees",
      ),
      "excluded",
    );
    assert.equal(assessWorktreeScanStatus(probe({ realTimeProtection: false }), WORKTREES), "off");
    assert.equal(
      assessWorktreeScanStatus(probe({ runningMode: "Passive mode" }), WORKTREES),
      "off",
    );
  });

  it("reports unknown when Defender could not be read", () => {
    assert.equal(assessWorktreeScanStatus(parseDefenderProbe(""), WORKTREES), "unknown");
    assert.equal(assessWorktreeScanStatus(parseDefenderProbe("not json"), WORKTREES), "unknown");
    assert.equal(
      assessWorktreeScanStatus(probe({ realTimeProtection: null, runningMode: null }), WORKTREES),
      "unknown",
    );
  });
});

describe("defenderExclusionCommand", () => {
  it("quotes the folder for PowerShell", () => {
    assert.equal(
      defenderExclusionCommand(WORKTREES),
      "Add-MpPreference -ExclusionPath 'C:\\Users\\super\\.goat\\worktrees'",
    );
    assert.equal(
      defenderExclusionCommand("C:\\Users\\o'brien\\.goat\\worktrees"),
      "Add-MpPreference -ExclusionPath 'C:\\Users\\o''brien\\.goat\\worktrees'",
    );
  });
});

describe("WorktreeCheckoutHealth", () => {
  it.effect("answers config loads without waiting for PowerShell", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const probes = yield* Ref.make(0);
      const runner = Layer.mock(ProcessRunner.ProcessRunner)({
        run: () =>
          Ref.update(probes, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as({
              stdout:
                '{"realTimeProtection":true,"runningMode":"Normal","exclusions":"","fileSystem":"NTFS"}',
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
          ),
      });
      const settings = Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({ worktreesDirectory: WORKTREES } as never),
        subscribeChanges: Effect.succeed(Stream.empty),
      });
      const layer = WorktreeCheckoutHealth.layer.pipe(
        Layer.provide(Layer.mergeAll(runner, settings)),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-checkout-health-" })),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const health = yield* WorktreeCheckoutHealth.WorktreeCheckoutHealth;
        // The startup probe is running and blocked, yet reads return at once without a second probe.
        yield* Deferred.await(started);
        const changes = yield* health.subscribeChanges;
        assert.isNull(yield* health.current);
        assert.isNull(yield* health.current);
        assert.equal(yield* Ref.get(probes), 1);
        yield* Deferred.succeed(release, undefined);
        // Connected clients hear the late answer, and later reads return it from the cache.
        const published = yield* Stream.runHead(changes);
        assert.equal(Option.getOrUndefined(published)?.defender, "scanning");
        assert.deepStrictEqual(yield* health.current, Option.getOrUndefined(published));
      }).pipe(Effect.provide(layer), Effect.provideService(HostProcess.Platform, "win32"));
    }),
  );
  it.effect("checks the new folder when the Worktree location setting changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const first = yield* fs.makeTempDirectoryScoped({ prefix: "goat-worktrees-a-" });
      const second = yield* fs.makeTempDirectoryScoped({ prefix: "goat-worktrees-b-" });
      const current = yield* Ref.make(first);
      const settingsChanges = yield* PubSub.unbounded<{ readonly worktreesDirectory: string }>();
      const gate = yield* Deferred.make<void>();
      const runner = Layer.mock(ProcessRunner.ProcessRunner)({
        run: () =>
          Deferred.await(gate).pipe(
            Effect.as({
              stdout:
                '{"realTimeProtection":true,"runningMode":"Normal","exclusions":"","fileSystem":"NTFS"}',
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
          ),
      });
      const settings = Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Ref.get(current).pipe(
          Effect.map((worktreesDirectory) => ({ worktreesDirectory }) as never),
        ),
        subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription) as never),
        ),
      });
      const layer = WorktreeCheckoutHealth.layer.pipe(
        Layer.provide(Layer.mergeAll(runner, settings)),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-checkout-health-" })),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const health = yield* WorktreeCheckoutHealth.WorktreeCheckoutHealth;
        const changes = yield* health.subscribeChanges;
        // Let the startup probe of the first folder finish before the setting moves.
        yield* Deferred.succeed(gate, undefined);
        const initial = yield* changes.pipe(Stream.take(1), Stream.runCollect);
        assert.isTrue(Array.from(initial)[0]?.worktreesDirectory.endsWith(first.split("/").pop()!));
        yield* Ref.set(current, second);
        yield* PubSub.publish(settingsChanges, { worktreesDirectory: second });
        const moved = yield* changes.pipe(
          Stream.filter((result) => result.worktreesDirectory.endsWith(second.split("/").pop()!)),
          Stream.runHead,
        );
        assert.equal(Option.getOrUndefined(moved)?.defender, "scanning");
      }).pipe(Effect.provide(layer), Effect.provideService(HostProcess.Platform, "win32"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
