import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";

import { goatAcpPromptWithInstructions } from "@goat/provider-core/server/orchestrationInstructions";
import { acpInstructionState } from "./screenInstructions.ts";
import { acpMcpContext } from "./mcpContext.ts";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

describe("ACP GOAT MCP context", () => {
  it("Grok, Antigravity and acpRegistry receive the attached screen guide with both MCP transports", () => {
    const context = acpMcpContext(
      {
        environmentId: EnvironmentId.make("environment-one"),
        threadId: ThreadId.make("thread-one"),
        providerSessionId: "session-one",
        providerInstanceId: ProviderInstanceId.make("acp"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test-token",
        browserToolsAvailable: true,
        builtInSkills: ["screen-code"],
      },
      { command: "/goat/node", entrypoint: undefined },
    );
    expect(context.screenCodeSkill).toBe(true);
    expect(context.computerUseSkill).toBe(false);
    expect(context.servers.some((server) => server.name === "goat")).toBe(true);
    expect(context.acpServers.some((server) => server.name === "goat")).toBe(true);
    expect(
      buildRuntimeInstructions({
        harness: "ACP",
        screenCode: context.screenCodeSkill,
        screenCodeCompact: true,
      }),
    ).toContain("goat_screen_run");
  });
});

it.each([undefined, false, true])(
  "uses real browser availability for ACP instructions, browser=%s",
  (browserToolsAvailable) => {
    const session =
      browserToolsAvailable === undefined
        ? undefined
        : {
            environmentId: EnvironmentId.make("browser-environment"),
            threadId: ThreadId.make("browser-thread"),
            providerSessionId: "browser-session",
            providerInstanceId: ProviderInstanceId.make("acp"),
            endpoint: "http://fixture.invalid/mcp",
            authorizationHeader: "Bearer fixture",
            browserToolsAvailable,
          };
    const context = acpMcpContext(session, { command: "/goat/node", entrypoint: undefined });
    const state = acpInstructionState(
      {
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
      },
      context,
    );
    const prompt = goatAcpPromptWithInstructions({ prompt: "Read the page", state });
    expect(prompt.includes("## GOAT browser")).toBe(browserToolsAvailable === true);
  },
);
