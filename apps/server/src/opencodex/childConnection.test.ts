import { expect, it } from "@effect/vitest";
import {
  type ChildReadyConnectionInput,
  type ChildReadyDeviceResult,
  EnvironmentId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as Profiles from "../goatclaw/PermissionProfiles.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import type * as UpdateHost from "../hub/OpenCodexUpdateHost.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type * as ProcessRunner from "../processRunner.ts";
import { makeChildConnection } from "./childConnection.ts";
import type * as Inventory from "./OpenCodexInventory.ts";

const destination = EnvironmentId.make("child");
const home = EnvironmentId.make("home");
const LINK = "lnk_0123456789abcdef";
// A thread scope on the Child: no client grants to check, ordinary hub.manage.
const scope: McpInvocationScope = {
  environmentId: destination,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "child-test",
  thread: undefined,
  client: undefined,
};

/** The Child's connection tool over a device whose OpenCodex is `version` and linked over LINK. */
const child = (version: string, answer: { code: number; stderr: string }) =>
  Effect.gen(function* () {
    const runs: Array<ReadonlyArray<string>> = [];
    const held: Array<string> = [];
    const device: ChildReadyDeviceResult = {
      kind: "device",
      destinationEnvironmentId: destination,
      homeEnvironmentId: home,
      device: {
        platform: "darwin",
        arch: "arm64",
        ocx: { path: "/opt/ocx", version, ownership: "adopted" },
        connection: { role: "client", linkId: LINK },
      },
      healthy: true,
      revision: { epoch: "e", sequence: 1 },
    };
    const connection = yield* makeChildConnection({
      destinationEnvironmentId: destination,
      profiles: { require: () => Effect.void } as unknown as Profiles.PermissionProfiles["Service"],
      runner: {
        run: (input: ProcessRunner.ProcessRunInput) =>
          Effect.sync(() => {
            runs.push(input.args);
            return {
              stdout: "",
              stderr: answer.stderr,
              code: ChildProcessSpawner.ExitCode(answer.code),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      } as unknown as ProcessRunner.ProcessRunner["Service"],
      host: {
        holdAdmission: () => Effect.sync(() => (held.push("hold"), true)),
        releaseAdmission: () => Effect.sync(() => void held.push("release")),
        member: () => Effect.succeed({ alias: null, runningTurns: 0, snapshot: undefined }),
      } as unknown as UpdateHost.OpenCodexUpdateHost["Service"],
      inventory: {
        readParity: Effect.succeed(fleetSnapshot("mac-studio")),
      } as unknown as Inventory.OpenCodexInventory["Service"],
      readDevice: () => Effect.succeed(device),
      invalidateProof: () => Effect.void,
      environment: {},
    });
    const input: ChildReadyConnectionInput = {
      destinationEnvironmentId: destination,
      homeEnvironmentId: home,
      operationId: "op",
      opencodexConnection: { kind: "sync", expectedLinkId: LINK },
    };
    return { run: connection(input, scope).pipe(Effect.result), runs, held };
  });

it.effect("a Child syncs only through ocx sync --expect-link, inside its admission fence", () =>
  Effect.gen(function* () {
    const { run, runs, held } = yield* child("2.100.2", { code: 0, stderr: "" });
    const result = yield* run;
    expect(result._tag).toBe("Success");
    expect(runs).toEqual([["sync", "--expect-link", LINK]]);
    expect(held).toEqual(["hold", "release"]);
  }),
);

it.effect("a link mismatch reports OpenCodex's reason and nothing else", () =>
  Effect.gen(function* () {
    const stderr =
      'Some note\n{"phase":"child_link_mismatch","reason":"other_link","secret":"ocx_pair_ABCDEFGHIJKLMNOPQRST"}\n';
    const { run } = yield* child("2.100.2", { code: 5, stderr });
    const result = yield* run;
    expect(result._tag === "Success" && result.success.code).toBe(5);
    expect(result._tag === "Success" && result.success.message).toBe(
      "This machine is not connected over that link (other_link); nothing was changed.",
    );
  }),
);

it.effect("an OpenCodex older than 2.93.0 is refused before anything runs", () =>
  Effect.gen(function* () {
    const { run, runs } = yield* child("2.92.0", { code: 0, stderr: "" });
    expect((yield* run)._tag).toBe("Failure");
    expect(runs).toEqual([]);
  }),
);
