import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import { sshPreparationFailure } from "../../client-runtime/src/connection/sshFailure.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { runSshCommand, SshReconnectCost } from "./command.ts";
import { SshCommandError } from "./errors.ts";
import { makeSuccessfulProcess, uploadTarget } from "./tunnel.fixture.ts";

// OpenSSH's verbose summaries are not all prefixed with "debug1:".
const chatter =
  [
    "OpenSSH_8.4p1, LibreSSL 2.8.3",
    "Pseudo-terminal will not be allocated because stdin is not a terminal.",
    'Authenticated using "publickey".',
    'Authenticated using "publickey" with partial success.',
    "Transferred: sent 2400, received 2300 bytes, in 0.1 seconds",
    "Bytes per second: sent 24000.0, received 23000.0",
  ].join("\n") + "\n";

describe("SSH verbose diagnostics", () => {
  it.effect.each([0, 1, 255])(
    "does not expose summaries for a silent command exiting %s",
    (exitCode) => {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed({
          ...makeSuccessfulProcess(""),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          stderr: Stream.make(new TextEncoder().encode(chatter)),
        }),
      );
      return Effect.gen(function* () {
        const result = yield* runSshCommand(uploadTarget).pipe(Effect.result);
        if (exitCode === 0) {
          assert.equal(result._tag, "Success");
          if (result._tag === "Success") assert.equal(result.success.stderr, "");
        } else {
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.equal(
              result.failure.message,
              `SSH command failed for alex@devbox (exit ${exitCode}).`,
            );
            if (result.failure instanceof SshCommandError) assert.equal(result.failure.stderr, "");
          }
        }
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      );
    },
  );

  it.effect("keeps a real remote error ahead of transfer summaries", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed({
        ...makeSuccessfulProcess(""),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        stderr: Stream.make(new TextEncoder().encode("remote operation failed\n" + chatter)),
      }),
    );
    return Effect.gen(function* () {
      const error = yield* runSshCommand(uploadTarget).pipe(Effect.flip);
      assert.equal(error.message, "remote operation failed");
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });
});

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "retains the Tailscale status from a real OpenSSH proxy banner",
  () =>
    Effect.gen(function* () {
      const error = yield* runSshCommand(uploadTarget, {
        preHostArgs: [
          "-F",
          "/dev/null",
          "-o",
          "IdentityFile=/dev/null",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "ProxyCommand=printf 'Tailscale is stopped.\\n'",
        ],
      }).pipe(Effect.flip);
      assert.include(error.message, "Tailscale proxy status: Tailscale is stopped.");
      assert.equal(sshPreparationFailure(error)._tag, "ConnectionBlockedError");
      if (error instanceof SshCommandError) {
        assert.notInclude(error.stderr, "debug1:");
        assert.notInclude(error.stderr, "OpenSSH_");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("counts DEBUG1 authentication lines across chunks without exposing them", () => {
  const cost = { active: true, spawns: 0, authentications: 0, steps: {} };
  const diagnostic = [
    "debug1: Executing proxy command: exec ssh -W target:22 jump\r\n",
    'Authenticated to jump ([127.0.0.1]:22) using "publickey".\r\n',
    "debug1: Authenticating to target:22 as 'user'\n",
    'Authenticated to target ([127.0.0.2]:22) using "publickey".\n',
    "debug1: mux_client_request_session: master session id: 2\n",
    chatter,
  ].join("");
  const bytes = new TextEncoder().encode(diagnostic);
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed({
      ...makeSuccessfulProcess("ok"),
      stderr: Stream.fromIterable(Array.from(bytes, (byte) => Uint8Array.of(byte))),
    }),
  );
  return Effect.gen(function* () {
    const result = yield* runSshCommand(uploadTarget);
    assert.equal(result.stdout, "ok");
    assert.equal(result.stderr, "");
    assert.equal(cost.spawns, 1);
    assert.equal(cost.authentications, 2);
  }).pipe(
    Effect.provideService(SshReconnectCost, cost),
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  );
});
