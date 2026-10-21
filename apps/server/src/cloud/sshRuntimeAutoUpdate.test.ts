// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { DEFAULT_SERVER_SETTINGS, ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import { SSH_REPLACEMENT_ID_ENV } from "../serverOwnerLock.ts";
import * as SshRuntimeAutoUpdate from "./sshRuntimeAutoUpdate.ts";

const PID = 4242;
const target = "1.1.0";

const makeHarness = Effect.fn("test.ssh_runtime_auto_update.harness")(function* (
  options: {
    readonly ownVersion?: string;
    readonly otherBaseDir?: boolean;
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-auto-update-" });
  const goatHome = NodePath.join(home, ".goat");
  const stateDir = NodePath.join(goatHome, "ssh-launch", "runtime");
  const versionDir = (version: string) =>
    NodePath.join(goatHome, "runtime", "goat", "versions", version);
  const files = new Map<string, string>([
    [NodePath.join(stateDir, "pid"), `${PID}\n`],
    [NodePath.join(stateDir, "managed"), "managed\n"],
    [NodePath.join(stateDir, "run-t3.sh"), "#!/bin/sh\n"],
  ]);
  const state = {
    activity: "idle" as "idle" | "busy",
    enabled: true,
    protocol: { ssh: SSH_RUNTIME_PROTOCOL_VERSION, orchestration: ORCHESTRATION_PROTOCOL_VERSION },
    installCode: 0,
    executableSha256: "exe-sha",
    preflight: undefined as Record<string, unknown> | undefined,
    launchOutput: '{"status":"ready","remotePort":3773}\n',
    installs: [] as string[],
    movedAside: [] as string[],
    preflights: [] as ReadonlyArray<string>[],
    launches: [] as {
      readonly script: string;
      readonly args: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv;
    }[],
  };
  const launchStarted = yield* Deferred.make<void>();
  const launchGate = yield* Deferred.make<void>();
  let holdLaunch = false;
  const host = SshRuntimeAutoUpdate.SshRuntimeHost.of({
    run: (input) =>
      Effect.sync(() => {
        if (input.command === "/bin/sh") {
          const version = /GOAT_ARCHIVE_VERSION='([^']+)'/.exec(input.stdin ?? "")?.[1] ?? "";
          state.installs.push(input.stdin ?? "");
          if (state.installCode !== 0) return { code: state.installCode, stdout: "", stderr: "" };
          files.set(NodePath.join(versionDir(version), ".install-complete"), `${version}\n`);
          files.set(
            NodePath.join(versionDir(version), ".install-record"),
            `${version} archive-sha exe-sha https\n`,
          );
          return { code: 0, stdout: `goat v${version}\n`, stderr: "" };
        }
        const version = NodePath.basename(NodePath.dirname(input.command));
        if (input.args[0] === "__ssh-helper") {
          const { ssh, orchestration } = state.protocol;
          return {
            code: 0,
            stdout: version + " " + ssh + " " + orchestration + " 0 0\n",
            stderr: "",
          };
        }
        state.preflights.push([input.command, ...input.args]);
        const preflight = state.preflight ?? { status: "ready", version, launcherProtocol: 3 };
        return { code: 0, stdout: JSON.stringify(preflight), stderr: "" };
      }),
    runDetached: (input) =>
      Effect.gen(function* () {
        state.launches.push(input);
        yield* Deferred.succeed(launchStarted, undefined);
        if (holdLaunch) yield* Deferred.await(launchGate);
        return { code: 0, stdout: state.launchOutput, stderr: "" };
      }),
    sha256: (file) =>
      Effect.sync(() =>
        file.endsWith("/goat")
          ? state.executableSha256
          : files.has(file)
            ? "runner-sha"
            : undefined,
      ),
    readText: (file) => Effect.sync(() => files.get(file)),
    moveAside: (dir) =>
      Effect.sync(() => {
        const aside = dir + ".aside";
        const moved = Array.from(files).filter(([file]) => file.startsWith(dir + "/"));
        for (const [file, text] of moved) {
          files.delete(file);
          files.set(aside + file.slice(dir.length), text);
        }
        state.movedAside.push(dir);
        return aside;
      }),
    remove: (dir) =>
      Effect.sync(() => {
        for (const file of Array.from(files.keys()))
          if (file.startsWith(dir + "/")) files.delete(file);
      }),
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(
      ServerConfig.layerTest(
        process.cwd(),
        options.otherBaseDir === true ? NodePath.join(home, "other") : goatHome,
      ),
    ),
  );
  const memory = yield* ProjectionStore.ProjectionStoreV2.pipe(
    Effect.provide(ProjectionStore.layerMemory),
  );
  const admission = yield* RuntimeAdmission.RuntimeAdmission.pipe(
    Effect.provide(RuntimeAdmission.layer),
  );
  const previous = process.env[SSH_REPLACEMENT_ID_ENV];
  process.env[SSH_REPLACEMENT_ID_ENV] = "previous-replacement";
  const runtime = yield* SshRuntimeAutoUpdate.make({
    ownVersion: options.ownVersion ?? "1.0.0",
    homeDir: home,
    pid: PID,
    platform: options.platform ?? "linux",
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (previous === undefined) delete process.env[SSH_REPLACEMENT_ID_ENV];
        else process.env[SSH_REPLACEMENT_ID_ENV] = previous;
      }),
    ),
    Effect.provideService(SshRuntimeAutoUpdate.SshRuntimeHost, host),
    Effect.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          automaticServerUpdates: state.enabled,
        })),
      }),
    ),
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(RuntimeAdmission.RuntimeAdmission, admission),
    Effect.provideService(ProjectionStore.ProjectionStoreV2, {
      ...memory,
      getServerActivity: () => Effect.sync(() => state.activity),
    }),
  );
  return {
    runtime,
    state,
    files,
    stateDir,
    home,
    launchStarted,
    launchGate,
    holdLaunch: () => {
      holdLaunch = true;
    },
  };
});

it.layer(NodeServices.layer)("SSH runtime auto-update", (it) => {
  it.effect("is owned only while the launch records name this managed process", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      expect(h.runtime.supported).toBe(true);
      expect(yield* h.runtime.owned).toBe(true);
      h.files.set(NodePath.join(h.stateDir, "pid"), "1\n");
      expect(yield* h.runtime.owned).toBe(false);
    }),
  );

  it.effect.each([{ platform: "win32" as const }, { otherBaseDir: true }])(
    "is unsupported for %o",
    (options) =>
      Effect.gen(function* () {
        const h = yield* makeHarness(options);
        expect(h.runtime.supported).toBe(false);
        expect(yield* h.runtime.owned).toBe(false);
      }),
  );

  it.effect("prepares through the checksum-verified host download and the preflight", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.prepare(target);
      expect(h.state.installs).toHaveLength(1);
      expect(h.state.installs[0]).toContain("SHA256SUMS");
      expect(h.state.preflights[0]).toContain("__service-preflight");
    }),
  );

  it.effect("downloads again over an install whose record does not match its executable", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const dir = NodePath.join(h.home, ".goat", "runtime", "goat", "versions", target);
      h.files.set(NodePath.join(dir, ".install-complete"), target + "\n");
      h.files.set(NodePath.join(dir, ".install-record"), target + " archive-sha other-sha https\n");
      yield* h.runtime.prepare(target);
      expect(h.state.movedAside).toEqual([dir]);
      expect(h.state.installs).toHaveLength(1);
      expect([...h.files.keys()].some((file) => file.startsWith(dir + ".aside"))).toBe(false);
    }),
  );

  it.effect("refuses an executable that no longer matches its verified install", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.state.executableSha256 = "tampered";
      const error = yield* h.runtime.prepare(target).pipe(Effect.flip);
      expect(error.reason).toContain("verified install");
      expect(h.state.preflights).toEqual([]);
    }),
  );

  it.effect("leaves a target with a protocol this runtime does not serve to the clients", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.state.protocol = {
        ssh: SSH_RUNTIME_PROTOCOL_VERSION,
        orchestration: ORCHESTRATION_PROTOCOL_VERSION + 1,
      };
      expect((yield* h.runtime.prepare(target).pipe(Effect.flip)).reason).toContain(
        "does not serve",
      );
      // Never prepared, so it can never be activated or win arbitration.
      expect((yield* h.runtime.activate(target).pipe(Effect.flip)).reason).toContain(
        "was not prepared",
      );
    }),
  );

  it.effect("refuses a target whose preflight is blocked", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.state.preflight = { status: "blocked", version: target, reason: "needs a migration" };
      expect((yield* h.runtime.prepare(target).pipe(Effect.flip)).reason).toBe("needs a migration");
    }),
  );

  it.effect("a busy server defers without starting the launch script", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.prepare(target);
      h.state.activity = "busy";
      expect(yield* h.runtime.activate(target)).toBe("busy");
      expect(h.state.launches).toEqual([]);
    }),
  );

  it.effect("activates through the owning launch script in a detached shell", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.prepare(target);
      expect(yield* h.runtime.activate(target)).toBe("requested");
      const [launch] = h.state.launches;
      expect(launch?.args).toEqual(["runtime"]);
      expect(launch?.script).toContain("REFRESH_IF_IDLE=1");
      expect(launch?.script).toContain("DRAIN_AUTOMATIC=1");
      expect(launch?.script).toContain("EXPECTED_INSTALLED_SHA256='exe-sha'");
      // The script checks the candidate against the protocol the target binary reported.
      expect(launch?.script).toContain(
        `[ "$2" = "${SSH_RUNTIME_PROTOCOL_VERSION}" ] && [ "$3" = "${ORCHESTRATION_PROTOCOL_VERSION}" ] && return 0`,
      );
      expect(launch?.env.HOME).toBe(h.home);
      // The supervisor and its rollback must not reuse this server's replacement identity.
      expect(launch?.env[SSH_REPLACEMENT_ID_ENV]).toBeUndefined();
    }),
  );

  it.effect("a pending launch result is a busy deferral", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.prepare(target);
      h.state.launchOutput = '{"status":"pending","pending":{"reason":"busy"}}\n';
      expect(yield* h.runtime.activate(target)).toBe("busy");
    }),
  );

  it.effect("a ready launch that kept a pending replacement is a busy deferral", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.prepare(target);
      h.state.launchOutput =
        '{"status":"ready","remotePort":3773,"serverKind":"managed","selectedVersion":"1.0.0","pending":{"reason":"busy"}}\n';
      expect(yield* h.runtime.activate(target)).toBe("busy");
    }),
  );

  it.effect("drops automatic refreshes while automatic updates are off", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.state.enabled = false;
      expect(yield* h.runtime.admitDrain({ targetVersion: "1.3.0", automatic: true })).toBe(false);
      expect(yield* h.runtime.admitDrain({ targetVersion: "1.3.0" })).toBe(true);
    }),
  );

  it.effect("holds one in-flight guard across activations", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.prepare(target);
      h.holdLaunch();
      const first = yield* h.runtime.activate(target).pipe(Effect.forkScoped);
      yield* Deferred.await(h.launchStarted);
      expect(yield* h.runtime.isUpdating).toBe(true);
      expect(yield* h.runtime.activate(target)).toBe("busy");
      yield* Deferred.succeed(h.launchGate, undefined);
      expect(yield* Fiber.join(first)).toBe("requested");
      expect(yield* h.runtime.isUpdating).toBe(false);
      expect(h.state.launches).toHaveLength(1);
    }),
  );

  it.effect("reads the failed target from the supervisor's record", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const record = NodePath.join(h.stateDir, "last-replacement.json");
      expect(yield* h.runtime.failedTarget).toBeUndefined();
      h.files.set(
        record,
        JSON.stringify({
          status: "rolled-back",
          targetVersion: target,
          previousVersion: "1.0.0",
          at: "x",
        }),
      );
      expect(yield* h.runtime.failedTarget).toBe(target);
      h.files.set(
        record,
        JSON.stringify({
          status: "replaced",
          targetVersion: target,
          previousVersion: "1.0.0",
          at: "x",
        }),
      );
      expect(yield* h.runtime.failedTarget).toBeUndefined();
    }),
  );

  it.effect("arbitrates two clients' automatic refreshes against its own prepared target", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.prepare("1.2.0");
      const admit = (targetVersion: string, automatic = true) =>
        h.runtime.admitDrain({ targetVersion, automatic });
      // Client A asks for an older release than the runtime's own target; client B a newer one.
      expect(yield* admit("1.1.0")).toBe(false);
      expect(yield* admit("1.3.0")).toBe(true);
      expect(yield* admit("1.2.0")).toBe(true);
      expect(yield* admit("0.9.0")).toBe(false);
      expect(yield* admit("1.3.0-nightly.20261001.1")).toBe(false);
      // Confirmed, manual and older-client requests are never arbitrated.
      expect(yield* admit("1.1.0", false)).toBe(true);
      h.files.set(
        NodePath.join(h.stateDir, "last-replacement.json"),
        JSON.stringify({
          status: "failed",
          targetVersion: "1.3.0",
          previousVersion: "1.0.0",
          at: "x",
        }),
      );
      expect(yield* admit("1.3.0")).toBe(false);
      yield* h.runtime.clearPending;
      expect(yield* admit("1.1.0")).toBe(true);
    }),
  );

  it.effect("a dev runtime leaves every client refresh alone", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ ownVersion: "1.0.0-dev.20261001.gabc" });
      expect(yield* h.runtime.admitDrain({ targetVersion: "0.1.0", automatic: true })).toBe(true);
    }),
  );
});

it.effect("the detached launcher returns the script's output through files", () =>
  Effect.gen(function* () {
    const host = yield* SshRuntimeAutoUpdate.SshRuntimeHost;
    const result = yield* host.runDetached({
      script: ['printf "%s\\n" "$1"', 'printf "%s\\n" "$GOAT_TEST_MARKER" >&2', "exit 3"].join(
        "\n",
      ),
      args: ["runtime"],
      env: { PATH: process.env.PATH, GOAT_TEST_MARKER: "marker" },
      cwd: process.cwd(),
    });
    expect(result).toEqual({ code: 3, stdout: "runtime\n", stderr: "marker\n" });
  }).pipe(Effect.provide(SshRuntimeAutoUpdate.layerHost)),
);

it.effect("a timed-out host command also stops the processes it started", () =>
  Effect.gen(function* () {
    const host = yield* SshRuntimeAutoUpdate.SshRuntimeHost;
    // The shell waits on a long download-like child; the timeout is the behavior under test.
    const result = yield* host.run({
      command: "/bin/sh",
      args: [
        "-c",
        'trap \'wait "$descendant"; exit 0\' TERM; sleep 600 & descendant=$!; printf "%s\\n" "$descendant"; wait "$descendant"',
      ],
      env: { PATH: process.env.PATH },
      timeoutMs: 200,
    });
    const descendant = Number(result.stdout.trim());
    expect(descendant).toBeGreaterThan(0);
    // The shell reaps its child before closing output, so a zombie cannot still answer signal 0.
    expect(() => process.kill(descendant, 0)).toThrow();
  }).pipe(Effect.provide(SshRuntimeAutoUpdate.layerHost)),
);

it.effect("a host command whose shell exits first still stops what it left running", () =>
  Effect.gen(function* () {
    const host = yield* SshRuntimeAutoUpdate.SshRuntimeHost;
    const result = yield* host.run({
      command: "/bin/sh",
      args: [
        "-c",
        `/bin/sh -c 'trap "wait; exit 0" TERM; sleep 600 & printf "%s\\n" "$!"; wait' & exit 0`,
      ],
      env: { PATH: process.env.PATH },
      timeoutMs: 200,
    });
    const descendant = Number(result.stdout.trim());
    expect(descendant).toBeGreaterThan(0);
    expect(() => process.kill(descendant, 0)).toThrow();
  }).pipe(Effect.provide(SshRuntimeAutoUpdate.layerHost)),
);
