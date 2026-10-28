// @effect-diagnostics nodeBuiltinImport:off - the remote fixture hashes the GOAT file it plants.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import { requestedRuntime } from "./remoteRuntime.ts";
import { buildProvisionedRuntimeExecutableScript } from "./runtimeExecutable.ts";
import { REMOTE_PROTOCOL_TOKEN_SCRIPT } from "./runtimeFactsScripts.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  ARCHIVE,
  isRemoteLaunch,
  makeRunningProcess,
  makeSuccessfulProcess,
  testHttpClient,
  testNetService,
} from "./tunnel.fixture.ts";

const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
const REMOTE_HOME = "/home/alex";
const executableOf = (version: string) =>
  `${REMOTE_HOME}/.goat/runtime/goat/versions/${version}/goat`;

/**
 * The real manager; SSH, the forward and the remote host are doubles. The remote answers an
 * executable lookup from the versions it has installed, as the generated script would.
 */
const makeHost = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-runtime-executable-" });
  const state = {
    selectedVersion: "1.2.2" as string,
    pending: false,
    installed: new Set<string>(["1.2.2", ARCHIVE.archiveVersion]),
    lookups: [] as Array<string>,
    gate: undefined as
      | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
      | undefined,
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
      if (command.args.includes("-G"))
        return makeSuccessfulProcess("hostname devbox\nuser alex\nport 22\n");
      if (command.args.includes("-N")) return makeRunningProcess(() => undefined);
      const stdin = command.options.stdin;
      const script =
        stdin !== undefined &&
        typeof stdin === "object" &&
        "stream" in stdin &&
        Stream.isStream(stdin.stream)
          ? yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString)
          : "";
      if (script.includes("__goat_runtime_executable=")) {
        state.lookups.push(script);
        const gate = state.gate;
        state.gate = undefined;
        if (gate !== undefined) {
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
        }
        const version = /^selected_version='([^']*)'$/mu.exec(script)?.[1] ?? "";
        return makeSuccessfulProcess(
          state.installed.has(version)
            ? `__goat_runtime_executable=${executableOf(version)}\n`
            : "",
        );
      }
      if (script.includes("ready=false") && !isRemoteLaunch(command.args))
        return makeSuccessfulProcess(
          JSON.stringify({ platform: "linux", arch: "x64", ready: true }),
        );
      if (script.includes("auth pairing create"))
        return makeSuccessfulProcess('{"credential":"pairing"}');
      if (!isRemoteLaunch(command.args)) return makeSuccessfulProcess("");
      return makeSuccessfulProcess(
        JSON.stringify(
          state.pending
            ? {
                status: "pending",
                pending: {
                  reason: "busy",
                  replacement: "incompatible",
                  requestedVersion: ARCHIVE.archiveVersion,
                  liveVersion: "1.2.2",
                },
              }
            : {
                status: "ready",
                selectedVersion: state.selectedVersion,
                remotePort: 3773,
                serverKind: "managed",
              },
        ),
      );
    }),
  );
  const layer = Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home })),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(NetService.NetService, testNetService),
    Layer.succeed(HttpClient.HttpClient, testHttpClient),
    SshAuth.SshPasswordPrompt.disabledLayer,
    SshTunnel.SshEnvironmentManager.layer({
      resolveCliRunner: Effect.sync(() => ({
        ...ARCHIVE,
        archiveDirectory: "",
        refreshOwnedRuntimeOnFirstConnection: true,
      })),
      leaveRemoteServerRunning: true,
    }),
  );
  return { state, layer };
});

const lookup = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const resolve = manager.provisionedRuntimeExecutable;
  if (resolve === undefined) return yield* Effect.die("The manager must resolve executables.");
  return yield* resolve(target);
});
const ensure = Effect.flatMap(SshTunnel.SshEnvironmentManager, (manager) =>
  manager.ensureEnvironment(target, { issuePairingToken: false }),
);
const disconnect = Effect.flatMap(SshTunnel.SshEnvironmentManager, (manager) =>
  manager.disconnectEnvironment(target),
);
/** Holds the next lookup on the remote until the test releases it. */
const holdNextLookup = (state: Effect.Success<typeof makeHost>["state"]) =>
  Effect.gen(function* () {
    const gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
    state.gate = gate;
    return gate;
  });

describe("provisioned GOAT executable", () => {
  it.effect(
    "resolves the selected installed GOAT executable when the requested version differs",
    () =>
      Effect.gen(function* () {
        const { state, layer } = yield* makeHost;
        const resolved = yield* Effect.gen(function* () {
          yield* ensure;
          return yield* lookup;
        }).pipe(Effect.provide(layer));
        assert.strictEqual(resolved, executableOf("1.2.2"));
        assert.strictEqual(state.lookups.length, 1);
        // The script checks only the selected version: no requested version, PATH or listing.
        const script = (state.lookups[0] ?? "").slice(REMOTE_PROTOCOL_TOKEN_SCRIPT.length);
        assert.include(script, "selected_version='1.2.2'");
        assert.notInclude(script, ARCHIVE.archiveVersion);
        assert.notMatch(script, /command -v|versions\/\*/u);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns no executable for an unprovisioned or pending alias", () =>
    Effect.gen(function* () {
      const { state, layer } = yield* makeHost;
      state.pending = true;
      const results = yield* Effect.gen(function* () {
        const before = yield* lookup;
        const ensured = yield* ensure;
        return { before, ensured, after: yield* lookup };
      }).pipe(Effect.provide(layer));
      assert.strictEqual(results.before, undefined);
      assert.strictEqual("type" in results.ensured && results.ensured.type, "ssh-runtime-pending");
      assert.strictEqual(results.after, undefined);
      assert.deepStrictEqual(state.lookups, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("discards an executable lookup overtaken by disconnect or runtime replacement", () =>
    Effect.gen(function* () {
      const { state, layer } = yield* makeHost;
      yield* Effect.gen(function* () {
        yield* ensure;
        const disconnected = yield* holdNextLookup(state);
        const first = yield* Effect.forkChild(lookup);
        yield* Deferred.await(disconnected.entered);
        yield* disconnect;
        yield* Deferred.succeed(disconnected.release, undefined);
        assert.strictEqual(yield* Fiber.join(first), undefined);

        yield* ensure;
        const replaced = yield* holdNextLookup(state);
        const second = yield* Effect.forkChild(lookup);
        yield* Deferred.await(replaced.entered);
        yield* disconnect;
        state.selectedVersion = ARCHIVE.archiveVersion;
        yield* ensure;
        yield* Deferred.succeed(replaced.release, undefined);
        assert.strictEqual(yield* Fiber.join(second), undefined);
        assert.strictEqual(yield* lookup, executableOf(ARCHIVE.archiveVersion));
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolves the replacement executable after reconnect instead of reusing the prior path",
    () =>
      Effect.gen(function* () {
        const { state, layer } = yield* makeHost;
        const results = yield* Effect.gen(function* () {
          yield* ensure;
          const first = yield* lookup;
          yield* disconnect;
          state.selectedVersion = ARCHIVE.archiveVersion;
          yield* ensure;
          const second = yield* lookup;
          // The replaced runtime is gone from the host: no stale answer survives.
          state.installed.delete(ARCHIVE.archiveVersion);
          return { first, second, gone: yield* lookup };
        }).pipe(Effect.provide(layer));
        assert.strictEqual(results.first, executableOf("1.2.2"));
        assert.strictEqual(results.second, executableOf(ARCHIVE.archiveVersion));
        assert.strictEqual(results.gone, undefined);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts only the complete selected install that reports its own version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "goat-sea-" }));
      const directory = `${home}/.goat/runtime/goat/versions/1.2.2`;
      const goat = `${directory}/goat`;
      const plant = (versionOutput: string, complete: string, mode = 0o755) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFileString(goat, `#!/bin/sh\necho '${versionOutput}'\n`, { mode });
          yield* fs.chmod(goat, mode);
          yield* fs.writeFileString(`${directory}/.install-complete`, complete);
          return NodeCrypto.createHash("sha256")
            .update(yield* fs.readFile(goat))
            .digest("hex");
        });
      const run = (digest: string | undefined) =>
        Effect.gen(function* () {
          const script = buildProvisionedRuntimeExecutableScript({
            ...requestedRuntime({ archiveVersion: "1.2.2" }),
            source: "retained",
            ...(digest === undefined ? {} : { installedExecutableSha256: digest }),
          });
          if (script === undefined) return yield* Effect.die("A selected SEA has a script.");
          const child = yield* spawner.spawn(
            ChildProcess.make("sh", ["-s"], {
              stdin: Stream.make(new TextEncoder().encode(script)),
              env: { HOME: home, PATH: "/usr/bin:/bin" },
            }),
          );
          const [stdout, code] = yield* Effect.all(
            [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
            { concurrency: "unbounded" },
          );
          return { stdout, code };
        });
      const digest = yield* plant("goat v1.2.2", "1.2.2");
      assert.deepStrictEqual(yield* run(digest), {
        stdout: `__goat_runtime_executable=${goat}\n`,
        code: ChildProcessSpawner.ExitCode(0),
      });
      assert.deepStrictEqual((yield* run("0".repeat(64))).stdout, "");
      yield* plant("goat v1.2.2", "1.2.1");
      assert.deepStrictEqual((yield* run(undefined)).stdout, "");
      yield* plant("goat v1.2.3", "1.2.2");
      assert.deepStrictEqual((yield* run(undefined)).stdout, "");
      yield* plant("goat v1.2.2", "1.2.2", 0o644);
      assert.deepStrictEqual((yield* run(undefined)).stdout, "");
      // Nothing to check without an installed single executable for this host.
      const node = requestedRuntime({ nodeScriptPath: "/opt/goat/bin.mjs" });
      const selected = requestedRuntime({ archiveVersion: "1.2.2" });
      for (const selection of [
        node,
        { ...selected, source: "app" as const },
        { ...selected, hostPlatform: "win32" as const },
        { ...selected, version: null },
        { ...selected, version: "1.2.2'; id; '" },
      ])
        assert.strictEqual(buildProvisionedRuntimeExecutableScript(selection), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
