import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { runSshCommand } from "./command.ts";
import { probeHostKey } from "./hostKey.ts";
import { DEV_SSH_REFUSAL, refuseSshHostsScoped } from "./hostAccess.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  NODE_SCRIPT,
  commandArgs,
  makeSuccessfulProcess,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";

const recordingSpawner = () => {
  const spawned: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      spawned.push(commandArgs(command));
      return makeSuccessfulProcess("hostname devbox.example.com\nuser alex\nport 2222\n");
    }),
  );
  return { spawned, spawner };
};

const withSpawner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HttpClient.HttpClient, testHttpClient),
    Layer.succeed(NetService.NetService, testNetService),
    Layer.succeed(SshAuth.SshPasswordPrompt, {
      isAvailable: false,
      request: () => Effect.die("a refused process never prompts"),
    }),
  );

describe("SSH refused for this process", () => {
  it.effect("a command spawns no ssh and says how to opt in", () => {
    const { spawned, spawner } = recordingSpawner();
    return Effect.gen(function* () {
      yield* refuseSshHostsScoped();
      const error = yield* runSshCommand(uploadTarget, { remoteCommandArgs: ["true"] }).pipe(
        Effect.flip,
      );
      assert.equal(error.message, DEV_SSH_REFUSAL);
      assert.deepEqual(spawned, []);
    }).pipe(Effect.provide(withSpawner(spawner)), Effect.scoped);
  });

  it.effect("a host key probe spawns nothing", () => {
    const { spawned, spawner } = recordingSpawner();
    return Effect.gen(function* () {
      yield* refuseSshHostsScoped();
      yield* probeHostKey({ target: "devbox.example.com" }).pipe(Effect.flip);
      assert.deepEqual(spawned, []);
    }).pipe(Effect.provide(withSpawner(spawner)), Effect.scoped);
  });

  it.effect("regression: connecting a host for the hub proxy or a dispatch spawns no ssh", () => {
    const { spawned, spawner } = recordingSpawner();
    return Effect.gen(function* () {
      yield* refuseSshHostsScoped();
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const error = yield* manager
        .ensureEnvironment(uploadTarget, { keyOnly: true, issuePairingToken: true })
        .pipe(Effect.flip);
      assert.include(error.message, "GOAT_DEV_SSH=on");
      assert.deepEqual(spawned, []);
    }).pipe(
      Effect.provide(
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: Effect.succeed(NODE_SCRIPT),
          leaveRemoteServerRunning: true,
        }).pipe(Layer.provideMerge(withSpawner(spawner))),
      ),
      Effect.scoped,
    );
  });

  it.effect("the same command spawns ssh once the scope that refused it ends", () => {
    const { spawned, spawner } = recordingSpawner();
    return Effect.gen(function* () {
      yield* Effect.scoped(refuseSshHostsScoped());
      yield* runSshCommand(uploadTarget, { remoteCommandArgs: ["true"] });
      assert.equal(spawned.length > 0, true);
    }).pipe(Effect.provide(withSpawner(spawner)), Effect.scoped);
  });
});
