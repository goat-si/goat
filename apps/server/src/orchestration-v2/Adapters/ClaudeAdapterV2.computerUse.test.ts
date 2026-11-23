import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as M from "@goat/contracts";
import { EnvironmentId, RunAttemptId, ThreadId } from "@goat/contracts";
import type * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { liveClaudeQueryFixture } from "./ClaudeMemoryDelivery.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";

const layerAdapterTest = layerClaudeAdapterTest;

describe("ClaudeAdapterV2 computer use", () => {
  const cuaDriver: M.CuaDriverMcpConfiguration = {
    command: "/resources/cua-driver",
    args: ["mcp", "--socket", "/tmp/cua.sock"],
    environment: [{ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" }],
    socketPath: "/tmp/cua.sock",
  };
  const session = (threadId: ThreadId): McpProviderSession.McpProviderSessionConfig => ({
    environmentId: EnvironmentId.make("fixture"),
    threadId,
    providerSessionId: "cua-credential",
    providerInstanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer fixture-cua",
    browserToolsAvailable: false,
    grantedScopes: [],
  });

  it("attaches the driver beside goat and preapproves it only outside read-only sandboxes", () => {
    const attached = { ...session(ThreadId.make("cua-overrides")), cuaDriver };
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: attached,
      readOnlySandbox: false,
    });
    assert.deepEqual(overrides.mcpServers?.["cua-driver"], {
      type: "stdio",
      command: "/resources/cua-driver",
      args: ["mcp", "--socket", "/tmp/cua.sock"],
      env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" },
    });
    assert.include(overrides.allowedTools ?? [], "mcp__cua-driver__*");

    const readOnly = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: attached,
      readOnlySandbox: true,
      allowedTools: ["mcp__cua-driver__click"],
    });
    assert.isUndefined(readOnly.mcpServers?.["cua-driver"]);
    assert.isFalse(
      (readOnly.allowedTools ?? []).some((tool) => tool.startsWith("mcp__cua-driver__")),
    );

    const detached = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: session(ThreadId.make("cua-overrides")),
      readOnlySandbox: false,
    });
    assert.isUndefined(detached.mcpServers?.["cua-driver"]);
    assert.notInclude(detached.allowedTools ?? [], "mcp__cua-driver__*");
  });

  it.effect("attaches and detaches the driver on a live query at the next turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("cua-claude");
        const config = session(threadId);
        const fixture = yield* liveClaudeQueryFixture(config, "cua-claude-native");
        const { offers, registrations, opened, sessions, runtime, providerThread, terminals } =
          fixture;
        // Permission checks run while the turn is active, as Claude asks during one.
        const turn = (ordinal: number, whileActive: Effect.Effect<void> = Effect.void) =>
          Effect.gen(function* () {
            yield* runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId,
                providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make(`cua-claude-${ordinal}`),
                text: `turn ${ordinal}`,
                attachments: [],
              }),
            );
            const offered = offers[offers.length - 1]!;
            yield* whileActive;
            yield* fixture.finish(offered, `00000000-0000-4000-8000-00000000010${ordinal}`);
            yield* Queue.take(terminals);
            return offered;
          });
        const expectPermission = (behavior: "allow" | "deny") =>
          Effect.promise(() =>
            opened[0]!.canUseTool!(
              "mcp__cua-driver__click",
              {},
              {
                signal: new AbortController().signal,
                toolUseID: `fixture-${behavior}`,
                requestId: `fixture-${behavior}`,
              },
            ),
          ).pipe(
            Effect.map((result) => {
              assert.equal(result?.behavior, behavior);
              if (behavior === "deny")
                assert.include(JSON.stringify(result), "Computer use is not attached");
            }),
          );
        const mentionsComputerUse = (message: SDKUserMessage) =>
          JSON.stringify(message.message.content).includes("<computer_use>");

        // Opened before computer use was enabled: no driver, no instructions.
        const first = yield* turn(1, expectPermission("deny"));
        assert.isUndefined(opened[0]?.mcpServers?.["cua-driver"]);
        assert.notInclude(JSON.stringify(opened[0]?.systemPrompt), "<computer_use>");
        assert.isFalse(mentionsComputerUse(first));

        // Enabled while the process lives: the next turn attaches it in place.
        yield* sessions.set({ ...config, cuaDriver });
        const second = yield* turn(2, expectPermission("allow"));
        assert.equal(opened.length, 1);
        assert.equal(fixture.closes, 0);
        assert.deepEqual(Object.keys(registrations[0] ?? {}).toSorted(), ["cua-driver", "goat"]);
        assert.isTrue(mentionsComputerUse(second));
        const third = yield* turn(3);
        assert.equal(registrations.length, 1);
        assert.isFalse(mentionsComputerUse(third));

        // Disabled: the driver leaves the live process and its tools are denied.
        yield* sessions.set(config);
        yield* turn(4, expectPermission("deny"));
        assert.equal(opened.length, 1);
        assert.deepEqual(Object.keys(registrations[1] ?? {}), ["goat"]);
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});
