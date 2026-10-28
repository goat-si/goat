import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NetService from "@goat/shared/Net";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import {
  uploadTarget,
  testHttpClient,
  testNetService,
  makeSuccessfulProcess,
} from "./tunnel.fixture.ts";
import { fixture } from "./tunnel.reconnect-probe.fixture.ts";
import * as SshAuth from "./auth.ts";
import { SshEnvironmentManager, type RemoteGoatRunnerOptions } from "./tunnel.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH folded reconnect probe",
  () => {
    it.live.each([
      "disconnect",
      "forget",
      "generation",
      "refresh",
      "confirmation",
      "version",
      "build",
      "config",
      "host",
      "invalidated",
      "failed refresh",
      "uncertain drain",
      "rejected attachment",
      "failed launch",
    ] as const)("does not retain wake selection after %s", (action) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.shiftHostClock(60);
        let forwardAlive = true;
        let configuration = "hostname devbox.example.com\nuser alex\nport 2222\n";
        let runner: RemoteGoatRunnerOptions = {
          ...f.runner,
          refreshOwnedRuntimeOnFirstConnection: true,
        };
        const transport = ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand" && command.args.includes("-G"))
            return Effect.succeed(makeSuccessfulProcess(configuration));
          if (command._tag === "StandardCommand" && command.args.includes("-N")) {
            forwardAlive = true;
            return Effect.succeed({
              ...makeRunningProcess(() => undefined),
              isRunning: Effect.sync(() => forwardAlive),
            });
          }
          return f.transport.spawn(command);
        });
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
          Layer.succeed(FileSystem.FileSystem, f.observedFs),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshEnvironmentManager.layer({
            resolveCliRunner: Effect.sync(() => runner),
            leaveRemoteServerRunning: true,
          }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          const snapshot = yield* f.snapshot;
          const failLaunch = `sh() {
  if [ "\${3:-}" = runtime ]; then return 23; fi
  command sh "$@"
}
`;
          if (action === "failed refresh" || action === "uncertain drain") {
            f.setScriptPrefix(failLaunch);
            const failed = yield* Effect.result(
              manager.ensureEnvironment(uploadTarget, { refreshRuntime: true }),
            );
            assert.equal(failed._tag, "Failure");
            f.setScriptPrefix("");
          }
          if (action === "rejected attachment") {
            f.setScriptPrefix(`sh() {
  if [ "\${3:-}" = runtime ]; then
    printf '%s\\n' '{"status":"pending","pending":{"reason":"busy","replacement":"incompatible","requestedVersion":"1.2.3","liveVersion":"1.2.3"}}'
    return 0
  fi
  command sh "$@"
}
`);
            const rejected = yield* manager.ensureEnvironment(uploadTarget, {
              refreshRuntime: true,
            });
            assert.isTrue("type" in rejected);
            f.setScriptPrefix("");
          }
          if (action === "uncertain drain" || action === "rejected attachment") {
            const status = yield* manager.status(uploadTarget);
            assert.equal(
              status.status?.state,
              action === "uncertain drain" ? "update_blocked" : "update_waiting",
            );
            assert.equal(
              (yield* Effect.result(manager.readyEnvironment(uploadTarget)))._tag,
              "Failure",
            );
          }
          forwardAlive = false;
          yield* manager.revalidateTunnels();
          if (action === "disconnect") yield* manager.disconnectEnvironment(uploadTarget);
          if (action === "forget")
            yield* manager.forgetEnvironment(uploadTarget, { stopRuntime: "no" });
          if (action === "generation")
            yield* manager.beginSetupOperation(uploadTarget, "wake-test");
          if (action === "version") runner = { ...f.runner, archiveVersion: "1.2.4" };
          if (action === "build") runner = { ...f.runner, archiveCommitTime: 1_700_000_001 };
          if (action === "config") configuration += "identityfile /changed-identity\n";
          if (action === "host") configuration = configuration.replace("devbox", "otherbox");
          if (action === "invalidated") {
            f.setScriptPrefix("printf 'fixture rejected probe\\n' >&2\nexit 23\n");
            const status = yield* manager.status(uploadTarget);
            assert.equal(status.kind, "error");
            f.setScriptPrefix("");
          }
          if (action === "failed launch") {
            f.setScriptPrefix(failLaunch);
            const before = f.remoteCommands.length;
            const failed = yield* Effect.result(manager.ensureEnvironment(uploadTarget));
            assert.equal(failed._tag, "Failure");
            assert.equal(f.remoteCommands.length - before, 1);
            f.setScriptPrefix("");
          }
          const before = f.remoteCommands.length;
          const result = yield* manager.ensureEnvironment(
            uploadTarget,
            action === "refresh"
              ? { refreshRuntime: true }
              : action === "confirmation"
                ? { confirmReplacement: true }
                : undefined,
          );
          assert.isFalse("type" in result);
          assert.equal(f.remoteCommands.length - before, 2);
          assert.deepEqual(yield* f.snapshot, snapshot);
          if (action === "uncertain drain" || action === "rejected attachment")
            yield* manager.readyEnvironment(uploadTarget);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
