import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { mergeThreadEnvironment } from "@goat/provider-core/server/mcpSession";

import { goatAcpPromptWithInstructions } from "@goat/provider-core/server/orchestrationInstructions";
import { acpInstructionState } from "./screenInstructions.ts";
import { acpMcpContext } from "./mcpContext.ts";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

describe("ACP GOAT MCP context", () => {
  it("passes the optional Windows launcher only to a connected session", () => {
    const session = {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("acp"),
      endpoint: "http://localhost/mcp",
      authorizationHeader: "fixture",
      browserToolsAvailable: false,
    };
    const self = { command: "node", entrypoint: undefined };
    expect(
      acpMcpContext(session, self, false, "C:\\state\\goat.cmd").processEnvironment
        ?.GOAT_ACP_MCP_CALL,
    ).toBe("C:\\state\\goat.cmd");
    expect(acpMcpContext(session, self).processEnvironment?.GOAT_ACP_MCP_CALL).toBeUndefined();
    const prompt = goatAcpPromptWithInstructions({
      prompt: "test",
      state: { interactionMode: "default", hasGoatMcp: true },
    });
    expect(prompt).toContain("'{}' | & $env:GOAT_ACP_MCP_CALL <path> -");
  });
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

  it("adds authenticated HTTP as a negotiated alternative only for the opted-in agent", () => {
    const self = { command: "/goat/node", entrypoint: undefined };
    const session = {
      environmentId: EnvironmentId.make("environment-one"),
      threadId: ThreadId.make("thread-one"),
      providerSessionId: "session-one",
      providerInstanceId: ProviderInstanceId.make("acp"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer fixture",
      browserToolsAvailable: false,
    };
    expect(acpMcpContext(session, self, true).httpServers).toEqual([
      {
        type: "http",
        name: "goat",
        url: session.endpoint,
        headers: [{ name: "Authorization", value: "Bearer fixture" }],
      },
    ]);
    expect(acpMcpContext(session, self).httpServers).toBeUndefined();
    expect(acpMcpContext(undefined, self, true).httpServers).toBeUndefined();
  });

  it("routes BROWSER to GOAT's opener only where the agent's own environment has none", () => {
    const opener = "/tmp/goat-threads-fixture/goat-browser";
    const { processEnvironment } = acpMcpContext(
      {
        environmentId: EnvironmentId.make("environment-one"),
        threadId: ThreadId.make("thread-one"),
        providerSessionId: "session-one",
        providerInstanceId: ProviderInstanceId.make("acp"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test-token",
        browserToolsAvailable: true,
        urlOpener: opener,
      },
      { command: "/goat/node", entrypoint: undefined },
    );
    // A registry distribution's or the user's BROWSER, even an empty one, is kept.
    for (const chosen of ["firefox", ""])
      expect(mergeThreadEnvironment({ BROWSER: chosen }, processEnvironment).BROWSER).toBe(chosen);
    const merged = mergeThreadEnvironment({ PATH: "/usr/bin" }, processEnvironment);
    expect(merged.BROWSER).toBe(opener);
    expect(merged.GOAT_ACP_MCP_AUTHORIZATION).toBe("Bearer test-token");
    expect(merged.GOAT_THREAD_ID).toBe("thread-one");
    expect(merged.T3CODE_THREAD_ID).toBe("thread-one"); // goat-rename: legacy
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

it("adds stdio GOAT servers to both ACP lists and drops HTTP", () => {
  const context = acpMcpContext(
    {
      environmentId: EnvironmentId.make("fixture"),
      threadId: ThreadId.make("fixture"),
      providerSessionId: "fixture",
      providerInstanceId: ProviderInstanceId.make("acp"),
      endpoint: "http://localhost/mcp",
      authorizationHeader: "fixture",
      browserToolsAvailable: false,
      goatMcpServers: [
        {
          providerName: "local_goat",
          transport: "stdio",
          command: "tool",
          args: ["run"],
          env: { KEY: "value" },
        },
        {
          providerName: "remote_goat",
          transport: "http",
          url: "https://example.test",
          headers: {},
        },
      ],
    },
    { command: "/goat/node", entrypoint: undefined },
  );
  const expected = {
    name: "local_goat",
    command: "tool",
    args: ["run"],
    env: [{ name: "KEY", value: "value" }],
  };
  expect(context.servers).toContainEqual(expected);
  expect(context.acpServers).toContainEqual(expected);
  expect(
    [...context.servers, ...context.acpServers].some((server) => server.name === "remote_goat"),
  ).toBe(false);
});
