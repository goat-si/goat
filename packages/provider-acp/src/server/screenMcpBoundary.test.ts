import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

import { acpMcpActivation, acpMcpContext } from "./mcpContext.ts";

it.each(["grok", "antigravity", "acpRegistry", "acp"] as const)(
  "%s sends GOAT's authenticated bridge in stdio and ACP registry forms, with detached screen guidance off",
  (driver) => {
    const session = {
      environmentId: EnvironmentId.make(`environment-${driver}-screen`),
      threadId: ThreadId.make(`thread-${driver}-screen`),
      providerSessionId: `session-${driver}-screen`,
      providerInstanceId: ProviderInstanceId.make(driver),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: `Bearer ${driver}-screen`,
      browserToolsAvailable: true,
      builtInSkills: ["screen-code"] as const,
      screenCodeSkillPath: "/state/skills/screen-code/SKILL.md",
    };
    const context = acpMcpContext(session, { command: "/goat/node", entrypoint: undefined });
    const activation = acpMcpActivation(context);
    expect(activation.mcpServers[0]).toMatchObject({
      name: "goat",
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "GOAT_ACP_MCP_ENDPOINT", value: session.endpoint },
        { name: "GOAT_ACP_MCP_AUTHORIZATION", value: session.authorizationHeader },
      ],
    });
    expect(activation.acpMcpServers[0]).toMatchObject({
      type: "acp",
      name: "goat",
      serverId: "goat",
    });
    // Provider-side approval is outside GOAT; this checks only the activation GOAT sends.
    expect(
      buildRuntimeInstructions({
        harness: "ACP",
        screenCode: context.screenCodeSkill,
        screenCodeSkillPath: context.screenCodeSkillPath,
        screenCodeCompact: true,
      }),
    ).toContain(session.screenCodeSkillPath);
    const { screenCodeSkillPath: _path, ...detached } = session;
    const refused = acpMcpContext(
      { ...detached, builtInSkills: [] },
      { command: "/goat/node", entrypoint: undefined },
    );
    expect(refused.screenCodeSkill).toBe(false);
  },
);
