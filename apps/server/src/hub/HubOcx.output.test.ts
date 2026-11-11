import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import { fleetSnapshot } from "./parity.testkit.ts";
import { HubOcx, layer as hubOcxLayer } from "./HubOcx.ts";

const output = (stdout: string, stderr: string, code: number) => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** HubOcx over a runner that answers `answer` and, like ProcessRunner, fails past its byte cap. */
const hubOcx = (answer: (input: ProcessRunner.ProcessRunInput) => ReturnType<typeof output>) =>
  HubOcx.pipe(
    Effect.provide(
      hubOcxLayer.pipe(
        Layer.provide(Layer.mock(HostThreads.HostThreadsMcpService)({})),
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: (
              input,
            ): Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError> => {
              const result = answer(input);
              const bytes = Buffer.byteLength(result.stdout);
              return input.maxOutputBytes !== undefined && bytes > input.maxOutputBytes
                ? Effect.fail(
                    new ProcessRunner.ProcessOutputLimitError({
                      command: input.command,
                      argumentCount: input.args.length,
                      cwd: input.cwd,
                      spawnCwd: undefined,
                      stream: "stdout",
                      maxBytes: input.maxOutputBytes,
                      observedBytes: bytes,
                    }),
                  )
                : Effect.succeed(result);
            },
          }),
        ),
        Layer.provide(
          Layer.mock(Inventory.OpenCodexInventory)({
            read: Effect.succeed({
              ...fleetSnapshot("home"),
              binaries: [{ path: "/usr/local/bin/ocx", version: "2.100.2" }],
            }),
          }),
        ),
        Layer.provide(Layer.mock(Dispatch.SshRemoteDispatch)({})),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

it.effect("a refused home ocx command carries OpenCodex's own message; hub invite never does", () =>
  Effect.gen(function* () {
    const stderr = "Error: Remote Link failed during Child restart preflight\n";
    const ocx = yield* hubOcx(() => output("", stderr, 1));
    const added = yield* ocx.home(["link", "add", "lidge", "--json"], 1_000);
    expect(added.message).toBe("Remote Link failed during Child restart preflight");
    const invite = yield* ocx.home(["hub", "invite", "--json"], 1_000);
    expect(invite.message).toBeUndefined();
  }),
);
