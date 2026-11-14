import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { requestedRuntime } from "./remoteRuntime.ts";
import { ChildProcessSpawner } from "effect/process";
import { prepareWindowsRuntime } from "./runtimeWindows.ts";
import { restrictedRunner } from "./existingOnly.ts";
import { makeSuccessfulProcess } from "./tunnel.fixture.ts";
import type { PreparationAdmission } from "./ensureFlight.ts";
import { fixture, retained, signals, stopped } from "./tunnel.runtime-status.fixture.ts";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { buildRemoteLaunchScript, launchOrReuseRemoteServer } from "./tunnel.ts";
import { makeEnsureFlightFixture } from "./tunnel.ensure-flight.fixture.ts";
import { uploadTarget } from "./tunnel.fixture.ts";
import { SshEnvironmentManager } from "./tunnel.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import { nativeScripts } from "./tunnel.fixture.ts";
import {
  fixture as hostFixture,
  nextVersion,
  oldVersion,
  shell,
  stateKey,
} from "./tunnel.runnerSwitch.fixture.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "existing-only launch on a host",
  () => {
    const launchFor = Effect.fn("test.existingOnly.launchFor")(function* (
      f: Effect.Success<ReturnType<typeof hostFixture>>,
    ) {
      const runner = restrictedRunner({ ...f.runner, archiveVersion: oldVersion });
      // An unrestricted selection made earlier: the launch itself must still refuse to publish.
      const scripts = yield* nativeScripts(runner, {
        ...requestedRuntime(runner),
        version: oldVersion,
        requestedVersion: nextVersion,
        source: "live",
        requireInstalled: false,
        mayUpgradeOwnedServer: true,
        refreshIfIdle: true,
      });
      return scripts.launch;
    });
    it.live("a wrapper another app wrote is refused and its bytes are left as they were", () =>
      Effect.gen(function* () {
        const f = yield* hostFixture("missing-release", { compatible: true });
        const wrapper = `${f.state}/run-t3.sh`;
        yield* f.fs.writeFileString(
          wrapper,
          (yield* f.fs.readFileString(wrapper)) + "# written by another app\n",
        );
        const before = yield* f.snapshot;
        const result = yield* shell(f.home, yield* launchFor(f), [stateKey]);
        assert.notEqual(result.code, 0);
        assert.include(result.stderr, "GOAT_EXISTING_RUNNER_REQUIRED");
        assert.deepEqual(yield* f.snapshot, before);
        assert.isFalse(yield* f.fs.exists(`${f.state}/run-goat.sh`));
        assert.isTrue(yield* f.oldProcess!.isRunning);
        assert.isFalse((yield* f.events).some((event) => event.version === nextVersion));
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
    it.live("a running compatible GOAT is attached to without writing its wrapper or alias", () =>
      Effect.gen(function* () {
        const f = yield* hostFixture("missing-release", { compatible: true });
        const before = yield* f.snapshot;
        const lifecycle = Effect.map(f.events, (events) =>
          events.map((event) => event.type).filter((type) => /^(?:start|stop|drain)/u.test(type)),
        );
        const lifecycleBefore = yield* lifecycle;
        const result = yield* shell(f.home, yield* launchFor(f), [stateKey]);
        assert.equal(result.code, 0, result.stderr);
        assert.include(result.stdout, `"selectedVersion":"${oldVersion}"`);
        assert.deepEqual(yield* f.snapshot, before);
        assert.isFalse(yield* f.fs.exists(`${f.state}/run-goat.sh`));
        assert.isTrue(yield* f.oldProcess!.isRunning);
        assert.deepEqual(yield* lifecycle, lifecycleBefore);
        yield* f.cleanCandidates;
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

describe("existing-only SSH preparation", () => {
  it.effect("rejects refresh without starting an installation", () =>
    Effect.gen(function* () {
      const f = yield* makeEnsureFlightFixture;
      f.state.holdUpload = false;
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const error = yield* Effect.flip(
          manager.ensureEnvironment(uploadTarget, {
            installation: "existing-only",
            refreshRuntime: true,
          }),
        );
        assert.equal(error._tag, "SshLaunchError");
        if (error._tag === "SshLaunchError")
          assert.equal(error.reason, "existing-runtime-required");
        assert.equal(f.count.uploads, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("fails without acquiring when no compatible runtime exists", () =>
    Effect.gen(function* () {
      const f = yield* makeEnsureFlightFixture;
      f.state.holdUpload = false;
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const error = yield* Effect.flip(
          manager.ensureEnvironment(uploadTarget, { installation: "existing-only" }),
        );
        assert.equal(error._tag, "SshLaunchError");
        if (error._tag === "SshLaunchError")
          assert.equal(error.reason, "existing-runtime-required");
        assert.equal(f.count.acquisitions, 0);
        assert.equal(f.count.uploads, 0);
        assert.equal(f.count.launches, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("reuses a compatible live runtime without uploading", () => {
    const version = "1.2.2";
    const f = fixture({
      ...stopped,
      liveStatus: "live",
      liveVersion: version,
      livePort: 3773,
      liveOwned: true,
      liveDrain: true,
      liveSignals: signals(version),
      liveBinarySignals: signals(version),
    });
    f.setLaunchVersion(version);
    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(uploadTarget, {}, restrictedRunner(ARCHIVE));
      assert.equal(result.status, "ready");
      assert.equal(f.calls.uploads, 0);
      assert.equal(f.calls.launches, 1);
      assert.include(
        f.launchScripts[0],
        'if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then',
      );
      assert.notInclude(f.launchScripts[0], 'mv "$RUNNER_NEXT" "$RUNNER_FILE"');
      for (const flag of [
        "REQUIRE_INSTALLED=1",
        "ALLOW_OWNED_UPGRADE=0",
        "ALLOW_LEGACY_ADOPTION=0",
        "REFRESH_IF_IDLE=0",
      ])
        assert.include(f.launchScripts[0], flag);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });
  it.effect("starts an older retained runtime without acquiring a newer one", () => {
    const f = fixture(retained);
    f.setLaunchVersion("1.2.2");
    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(uploadTarget, {}, restrictedRunner(ARCHIVE));
      assert.equal(result.status, "ready");
      if (result.status === "ready") assert.equal(result.selectedRuntime.version, "1.2.2");
      assert.equal(f.calls.uploads, 0);
      assert.equal(f.calls.launches, 1);
      assert.include(
        f.launchScripts[0],
        'if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then',
      );
      assert.notInclude(f.launchScripts[0], 'mv "$RUNNER_NEXT" "$RUNNER_FILE"');
      for (const flag of [
        "REQUIRE_INSTALLED=1",
        "ALLOW_OWNED_UPGRADE=0",
        "ALLOW_LEGACY_ADOPTION=0",
        "REFRESH_IF_IDLE=0",
      ])
        assert.include(f.launchScripts[0], flag);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });
  it.effect(
    "a host whose wrapper names no compatible runtime fails without publishing a wrapper, even when another compatible runtime is installed",
    () => {
      const version = "1.2.4";
      const f = fixture({
        ...stopped,
        installedCandidates: [
          { version, signals: signals(version), executableSha256: "a".repeat(64) },
        ],
      });
      f.setLaunchVersion(version);
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          launchOrReuseRemoteServer(uploadTarget, {}, restrictedRunner(ARCHIVE)),
        );
        assert.equal(error._tag, "SshLaunchError");
        if (error._tag === "SshLaunchError")
          assert.equal(error.reason, "existing-runtime-required");
        assert.equal(f.calls.uploads, 0);
        assert.equal(f.calls.launches, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );
  it.effect("native Windows without an installed runtime fails before installation", () => {
    let calls = 0;
    const fake = ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        calls++;
        return makeSuccessfulProcess(JSON.stringify({ selection: null, live: false }));
      }),
    );
    return Effect.gen(function* () {
      const runner = { ...ARCHIVE, installation: "existing-only" as const };
      const error = yield* prepareWindowsRuntime(uploadTarget, {}, runner).pipe(Effect.flip);
      assert.equal(error._tag, "SshLaunchError");
      if (error._tag === "SshLaunchError") assert.equal(error.reason, "existing-runtime-required");
      assert.equal(calls, 1);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake),
      Effect.provide(NodeServices.layer),
    );
  });
  it("forces installed-only launch flags even for an unrestricted selection", () => {
    const runner = { ...ARCHIVE, installation: "existing-only" as const };
    const script = buildRemoteLaunchScript(runner);
    assert.include(
      script,
      'if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then',
    );
    assert.notInclude(script, 'mv "$RUNNER_NEXT" "$RUNNER_FILE"');
    assert.include(script, "REQUIRE_INSTALLED=1");
    assert.include(script, "ALLOW_OWNED_UPGRADE=0");
    assert.include(script, "ALLOW_LEGACY_ADOPTION=0");
    assert.include(script, "REFRESH_IF_IDLE=0");
  });
  it.effect("a folded reconnect forces installed-only flags for an unrestricted selection", () => {
    const scripts: string[] = [];
    const fake = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
        const input = command.options.stdin;
        if (
          input === undefined ||
          typeof input !== "object" ||
          !("stream" in input) ||
          !Stream.isStream(input.stream)
        )
          return yield* Effect.die("Missing script");
        scripts.push(yield* input.stream.pipe(Stream.decodeText(), Stream.mkString));
        return makeSuccessfulProcess(
          JSON.stringify({
            status: "ready",
            selectedVersion: ARCHIVE.archiveVersion,
            remotePort: 3773,
            serverKind: "managed",
          }),
        );
      }),
    );
    return Effect.gen(function* () {
      const previous = {
        ...requestedRuntime(restrictedRunner(ARCHIVE)),
        reconnectProbe: "fixture-baseline",
        refreshIfIdle: true,
      };
      const result = yield* launchOrReuseRemoteServer(
        uploadTarget,
        {},
        restrictedRunner(ARCHIVE),
        undefined,
        previous,
      );
      assert.equal(result.status, "ready");
      assert.equal(scripts.length, 1);
      assert.include(
        scripts[0],
        'if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then',
      );
      assert.notInclude(scripts[0], 'mv "$RUNNER_NEXT" "$RUNNER_FILE"');
      assert.include(scripts[0], "REQUIRE_INSTALLED=1");
      assert.notInclude(scripts[0], "ALLOW_OWNED_UPGRADE=1");
      assert.notInclude(scripts[0], "ALLOW_LEGACY_ADOPTION=1");
      assert.notInclude(scripts[0], "REFRESH_IF_IDLE=1");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake),
      Effect.provide(NodeServices.layer),
    );
  });
  it.effect("reports a changed existing wrapper as existing-runtime-required", () => {
    const fake = ChildProcessSpawner.make(() =>
      Effect.succeed({
        ...makeSuccessfulProcess(""),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        stderr: Stream.make(new TextEncoder().encode("GOAT_EXISTING_RUNNER_REQUIRED\n")),
      }),
    );
    return Effect.gen(function* () {
      const runner = restrictedRunner(ARCHIVE);
      const previous = { ...requestedRuntime(runner), reconnectProbe: "fixture-baseline" };
      const error = yield* Effect.flip(
        launchOrReuseRemoteServer(uploadTarget, {}, runner, undefined, previous),
      );
      assert.equal(error._tag, "SshLaunchError");
      if (error._tag === "SshLaunchError") assert.equal(error.reason, "existing-runtime-required");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );
  });
  it.effect("a restricted ensure does not join an installing flight", () =>
    Effect.gen(function* () {
      const f = yield* makeEnsureFlightFixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const admissions = yield* Queue.unbounded<PreparationAdmission>();
        const observed = yield* Deferred.make<void>();
        const first = yield* manager.ensureEnvironment(uploadTarget).pipe(Effect.forkChild);
        yield* Deferred.await(f.uploadEntered);
        const second = yield* manager
          .ensureEnvironment(uploadTarget, {
            installation: "existing-only",
            onPreparationProgress: () => {
              Deferred.doneUnsafe(observed, Effect.void);
            },
            onPreparationAdmission: (value) => {
              Queue.offerUnsafe(admissions, value);
            },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(observed);
        yield* Deferred.succeed(f.releaseUpload, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.equal((yield* Queue.take(admissions)).disposition, "leader");
        assert.equal(f.count.uploads, 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("restricted ensure leaves an earlier replacement pending", () =>
    Effect.gen(function* () {
      const f = yield* makeEnsureFlightFixture;
      f.state.holdUpload = false;
      f.state.pendingReplacement = true;
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const first = yield* manager.ensureEnvironment(uploadTarget);
        if ("type" in first) return yield* Effect.die("Expected ready attachment");
        assert.equal(first.pendingReplacement?.liveVersion, "1.2.2");
        const before = f.count.launches;
        const second = yield* manager.ensureEnvironment(uploadTarget, {
          installation: "existing-only",
        });
        if ("type" in second) return yield* Effect.die("Expected ready attachment");
        assert.deepEqual(second.pendingReplacement, first.pendingReplacement);
        assert.equal(f.count.launches, before);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("attaches to an app server and preserves it when session issuance is refused", () =>
    Effect.gen(function* () {
      const f = yield* makeEnsureFlightFixture;
      f.runner.attachAppServer = true;
      f.state.appServer = true;
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const ready = yield* manager.ensureEnvironment(uploadTarget, {
          installation: "existing-only",
        });
        assert.notProperty(ready, "type");
        if (!("type" in ready)) assert.equal(ready.remoteServerKind, "app");
        const error = yield* Effect.flip(
          manager.issueClientSession(uploadTarget, {
            installation: "existing-only",
            subject: "test",
            label: "test",
            ttl: "1h",
            scopes: ["orchestration:read"],
          }),
        );
        assert.equal(error._tag, "SshPairingError");
        assert.equal(f.app.requests, 1);
        assert.equal(f.count.uploads, 0);
        assert.equal(f.count.launches, 0);
        const again = yield* manager.ensureEnvironment(uploadTarget, {
          installation: "existing-only",
        });
        if (!("type" in again)) assert.equal(again.remoteServerKind, "app");
        assert.equal(f.count.launches, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("issuing a session without a runtime fails without acquisition", () =>
    Effect.gen(function* () {
      const f = yield* makeEnsureFlightFixture;
      f.state.holdUpload = false;
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const error = yield* Effect.flip(
          manager.issueClientSession(uploadTarget, {
            installation: "existing-only",
            subject: "test",
            label: "test",
            ttl: "1h",
            scopes: ["orchestration:read"],
          }),
        );
        assert.equal(error._tag, "SshLaunchError");
        if (error._tag === "SshLaunchError")
          assert.equal(error.reason, "existing-runtime-required");
        assert.equal(f.count.uploads, 0);
        assert.equal(f.count.acquisitions, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
