import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@goat/shared/HostProcess";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import { makeAcpClientTerminals } from "./clientTerminals.ts";

it.effect("reports missing Git Bash instead of running shell source through cmd.exe", () =>
  Effect.gen(function* () {
    const terminals = yield* makeAcpClientTerminals({
      defaultCwd: "C:\\workspace",
      shellCommands: true,
    });
    const error = yield* Effect.flip(
      terminals.create({ sessionId: "devin", command: "printf ok" }),
    );
    expect(String(error)).toContain("Git Bash is required");
  }).pipe(
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(SpawnExecutableResolution, async () => undefined),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);
