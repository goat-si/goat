import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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

const isSpawnError = Schema.is(ProcessRunner.ProcessSpawnError);

/** HubOcx over a runner that answers `answer` and, like ProcessRunner, fails past its byte cap. */
const hubOcx = (
  answer: (
    input: ProcessRunner.ProcessRunInput,
  ) => ReturnType<typeof output> | ProcessRunner.ProcessSpawnError,
) =>
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
              if (isSpawnError(result)) return Effect.fail(result);
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
it.effect(
  "ocx link routes refusals carry OpenCodex's fixed code and its cause word, nothing else",
  () =>
    Effect.gen(function* () {
      // As OpenCodex src/cli/link-routes.ts prints them through runCliAction.
      const unproven = "Error: Link routes request refused (409): route_unproven (hostkey)\n";
      const stored =
        "Error: Link routes request refused (500): routes_stored_reload_failed; the routes were stored\n";
      const exclusive = "Error: Link routes request refused (409): link_exclusive\n";
      const joined = "Error: Link routes request refused (409): link_not_home_initiated\n";
      const answers = [
        output("", unproven, 5),
        output("", stored, 1),
        output("", exclusive, 5),
        output("", joined, 5),
      ];
      const ocx = yield* hubOcx(() => answers.shift() ?? output("", "", 1));
      const args = [
        "link",
        "routes",
        "add",
        "--link-id",
        "lnk_0123456789abcdef",
        "--route",
        "x",
        "--json",
      ];
      expect(yield* ocx.home(args, 1_000)).toMatchObject({
        code: 5,
        phase: "route_unproven",
        cause: "hostkey",
      });
      const reload = yield* ocx.home(args, 1_000);
      expect(reload).toMatchObject({ code: 1, phase: "routes_stored_reload_failed" });
      expect(reload.cause).toBeUndefined();
      expect(yield* ocx.home(args, 1_000)).toMatchObject({ code: 5, phase: "link_exclusive" });
      expect(yield* ocx.home(args, 1_000)).toMatchObject({
        code: 5,
        phase: "link_not_home_initiated",
      });
    }),
);
it.effect("a ps listing over 256 KiB still counts this Home's link tunnels", () =>
  Effect.gen(function* () {
    const busy = Array.from(
      { length: 3_000 },
      (_, index) =>
        `/Applications/Some Electron.app/Contents/Frameworks/Helper --type=renderer --field-trial-handle=${"x".repeat(80)} --seed=${index}`,
    );
    const tunnel = "/usr/bin/ssh -N -R 127.0.0.1:42255:127.0.0.1:10100 -- lidge";
    const listing = [...busy, tunnel].join("\n");
    expect(Buffer.byteLength(listing)).toBeGreaterThan(256 * 1024);
    const ocx = yield* hubOcx(() => output(listing, "", 0));
    expect(yield* ocx.homeTunnels("lidge", 42255)).toBe(1);
  }),
);
it.effect(
  "an ocx that cannot be started is its own failure, apart from one that stopped after it ran",
  () =>
    Effect.gen(function* () {
      const ocx = yield* hubOcx(
        (input) =>
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cwd: input.cwd,
            spawnCwd: undefined,
            cause: new Error("ENOENT"),
          }),
      );
      const failed = yield* Effect.flip(ocx.home(["link", "routes", "--json"], 1_000));
      expect(failed).toMatchObject({ reason: "ocx_unstartable" });
    }),
);
