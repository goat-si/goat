import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  commandArgs,
  encoder,
  makeRunningProcess,
  makeSuccessfulProcess,
  testHttpClient,
  testNetService,
  uploadTarget,
  NODE_SCRIPT,
  isRemoteLaunch,
} from "./tunnel.fixture.ts";

describe.each([
  [false, false, true],
  [true, true, true],
  [true, false, false],
])("key-only SSH cached=%s reuse=%s failure=%s", (cachePassword, reuseTunnel, authFails) => {
  it.effect("uses batch key authentication and never prompts on failure", () => {
    let prompts = 0;
    let phase: "cache" | "key-only" = cachePassword ? "cache" : "key-only";
    const keyCalls: Array<{
      batch: string | undefined;
      secret: string | undefined;
      askpass: string | undefined;
    }> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-G"))
          return makeSuccessfulProcess("hostname devbox.example.com\nuser alex\nport 2222\n");
        if (phase === "key-only" && command._tag === "StandardCommand")
          keyCalls.push({
            batch: args.find((arg) => arg.startsWith("BatchMode=")),
            secret: command.options.env?.T3_SSH_AUTH_SECRET,
            askpass: command.options.env?.SSH_ASKPASS_REQUIRE,
          });
        if (
          (phase === "key-only" && authFails) ||
          (phase === "cache" &&
            command._tag === "StandardCommand" &&
            command.options.env?.T3_SSH_AUTH_SECRET === undefined)
        )
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
            stderr: Stream.make(encoder.encode("Permission denied (publickey,password).")),
          };
        if (args.includes("-N")) return makeRunningProcess(() => undefined);
        return makeSuccessfulProcess(
          isRemoteLaunch(args)
            ? '{"status":"ready","remotePort":3773,"selectedVersion":"0.1.0"}'
            : '{"credential":"fixture-pairing"}',
        );
      }),
    );
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      if (cachePassword) {
        yield* manager.ensureEnvironment(uploadTarget);
        assert.equal(prompts, 1);
        if (!reuseTunnel) yield* manager.disconnectEnvironment(uploadTarget);
        phase = "key-only";
      }
      if (authFails) {
        const error = yield* manager
          .ensureEnvironment(uploadTarget, { keyOnly: true, issuePairingToken: true })
          .pipe(Effect.flip);
        assert.include(error.message, "Key-based login failed for devbox");
        assert.include(error.message, "agents use only SSH keys or ssh-agent");
      } else {
        const result = yield* manager.ensureEnvironment(uploadTarget, {
          keyOnly: true,
          issuePairingToken: true,
        });
        if ("type" in result) throw new Error("unexpected pending runtime replacement");
        assert.equal(result.pairingToken, "fixture-pairing");
        assert.isAtLeast(keyCalls.length, 3);
      }
      assert.equal(prompts, cachePassword ? 1 : 0);
      assert.isAbove(keyCalls.length, 0);
      for (const call of keyCalls)
        assert.deepEqual(call, { batch: "BatchMode=yes", secret: undefined, askpass: undefined });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          Layer.succeed(SshAuth.SshPasswordPrompt, {
            isAvailable: true,
            request: () =>
              Effect.sync(() => {
                prompts++;
                return "fixture-password";
              }),
          }),
          SshTunnel.SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(NODE_SCRIPT),
            leaveRemoteServerRunning: true,
          }),
        ),
      ),
      Effect.scoped,
    );
  });
});
