import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { sshPreparationFailure } from "../../client-runtime/src/connection/sshFailure.ts";
import * as SshAuth from "./auth.ts";
import { runSshCommand } from "./command.ts";
import {
  makeSuccessfulProcess,
  NODE_SCRIPT,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";
import { SshEnvironmentManager } from "./tunnel.ts";
import { makeEnsureFlightFixture } from "./tunnel.ensure-flight.fixture.ts";

const closure = "\nConnection closed by UNKNOWN port 65535";
const cases = [
  [
    "fixture@jump: Permission denied (publickey).\nkex_exchange_identification: Connection closed by remote host\nConnection closed by UNKNOWN port 65535",
    "authentication",
  ],
  ["Connection to 192.0.2.1 port 22 timed out", "host-unreachable"],
  ["Connection timed out during banner exchange", "host-unreachable"],
  ["ssh: connect to host 192.0.2.1 port 22: Host is down", "host-unreachable"],
  ["cloudflared: 404 Not Found" + closure, "host-unreachable"],
  ["cloudflared: route not found" + closure, "host-unreachable"],
  ["tailscale: item not found in the data protection keychain" + closure, "host-unreachable"],
  ["connect to tailscale-mbp: Socket is not connected" + closure, "host-unreachable"],
  ["Tailscale is stopped." + closure, "configuration"],
  ["Tailscale is not running." + closure, "configuration"],
  ["tailscale: logged out." + closure, "configuration"],
  ["Tailscale proxy status: Logged out." + closure, "configuration"],
  ["failed to connect to local Tailscale daemon; is Tailscale running?" + closure, "configuration"],
  [
    "Failed to connect to local Tailscale daemon; Error: dial unix: Permission denied" + closure,
    "configuration",
  ],
  ["posix_spawn: No such file or directory" + closure, "configuration"],
  ["/bin/sh: line 1: tailscale: command not found" + closure, "configuration"],
  [
    "/bin/sh: line 1: foo: command not found\nRemote host is missing node on PATH",
    "remote-unavailable",
  ],
  [
    "/bin/bash: line 1: /missing/foo: No such file or directory\nRemote host is missing node on PATH",
    "remote-unavailable",
  ],
] as const;

describe("SSH preparation/runtime status parity", () => {
  it.effect(
    "owner invalidation is neutral and cannot publish an authentication/runtime failure",
    () =>
      Effect.gen(function* () {
        const f = yield* makeEnsureFlightFixture;
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          const superseded = yield* Deferred.make<void>();
          const ensure = yield* Effect.result(
            manager.ensureEnvironment(uploadTarget, {
              onPreparationProgress: (progress) => {
                if (progress.outcome === "superseded") Deferred.doneUnsafe(superseded, Exit.void);
              },
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(f.uploadEntered);
          const disconnect = yield* manager
            .disconnectEnvironment(uploadTarget)
            .pipe(Effect.forkChild);
          yield* Deferred.await(superseded);
          const result = yield* Fiber.join(ensure);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            assert.equal(result.failure._tag, "SshEnsureSupersededError");
            assert.equal(sshPreparationFailure(result.failure)._tag, "ConnectionAttemptSuperseded");
          }
          yield* Deferred.succeed(f.releaseUpload, undefined);
          yield* Fiber.join(disconnect);
          const status = yield* manager.status(uploadTarget);
          assert.notEqual(status.status?.state, "auth_failed");
          assert.notEqual(status.status?.state, "failed");
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect.each(cases)("classifies real stderr consistently: %s", ([stderr, expected]) => {
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.succeed(
        command._tag === "StandardCommand" && command.args.includes("-G")
          ? makeSuccessfulProcess("hostname fixture\nuser fixture\nport 22\n")
          : {
              ...makeSuccessfulProcess(""),
              stderr: Stream.make(new TextEncoder().encode(stderr)),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
            },
      ),
    );
    return Effect.gen(function* () {
      // Exercise runSshCommand's normalization before the browser-safe classifier.
      const error = yield* runSshCommand(uploadTarget).pipe(Effect.flip);
      const client = sshPreparationFailure(error);
      assert.equal(client.reason, expected);
      const manager = yield* SshEnvironmentManager;
      const result = yield* manager.status(uploadTarget);
      if (expected === "host-unreachable") {
        assert.equal(result.kind, "error");
        if (result.kind === "error") assert.equal(result.code, "host_unreachable");
      } else if (expected === "authentication") {
        assert.equal(client._tag, "ConnectionBlockedError");
        assert.equal(result.status?.state, "auth_failed");
        assert.include(result.status?.detail ?? "", "fixture@jump: Permission denied (publickey).");
      } else if (expected === "configuration") {
        assert.equal(result.kind, "error");
        if (result.kind === "error") {
          assert.equal(result.code, "operation_failed");
          assert.equal(result.fix?.actor, "human");
          assert.include(client.detail ?? "", result.fix?.instruction ?? "missing fix");
          assert.include(result.message, stderr.split("\n")[0]!);
        }
      } else {
        assert.equal(result.status?.failure?.reason, "missing_tools");
        assert.include(result.status?.failure?.fix.instruction ?? "", "Install Node");
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(NetService.NetService, testNetService),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(NODE_SCRIPT),
            leaveRemoteServerRunning: true,
          }),
        ),
      ),
    );
  });
});
