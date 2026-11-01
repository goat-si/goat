import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import type * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { GOAT_SUBAGENT_GATE_ENV } from "./mcpExtensionSource.ts";
import { buildPiRpcLaunch } from "./mcpInjection.ts";
import { openPiTurnGates, writePiTurnGates } from "./turnGates.ts";

const session: McpProviderSession.McpProviderSessionConfig = {
  environmentId: EnvironmentId.make("environment-pi-subagents"),
  threadId: ThreadId.make("thread-pi-subagents"),
  providerSessionId: "mcp-session-pi-subagents",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: false,
};

it.effect("closes Pi's subagent tool for each turn whose goatclaw limit is zero", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const gates = yield* openPiTurnGates(fileSystem, { ...session, nativeSubagentLimit: 0 });
    const gate = () => fileSystem.readFileString(gates.subagentsPath!);
    assert.equal(yield* gate(), "off");
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: { [GOAT_SUBAGENT_GATE_ENV]: "/inherited" },
      mcpSession: session,
      extensionPath: "/tmp/pi-goat-mcp-extension.ts",
      subagentGatePath: gates.subagentsPath,
    });
    assert.equal(launch.env[GOAT_SUBAGENT_GATE_ENV], gates.subagentsPath);
    // Pi has no concurrency cap, so a positive limit leaves the tool open.
    for (const [nativeSubagentLimit, expected] of [
      [2, "on"],
      [0, "off"],
      [undefined, "on"],
    ] as const) {
      yield* writePiTurnGates(
        fileSystem,
        gates,
        Effect.succeed(
          nativeSubagentLimit === undefined ? session : { ...session, nativeSubagentLimit },
        ),
      );
      assert.equal(yield* gate(), expected);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
