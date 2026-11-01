import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type AuthMcpWorkspaceTerminalScope,
} from "@goat/contracts";

export const mcpClientScopes = (
  access: AuthMcpClientAccess,
  memoryScopes: ReadonlyArray<"memory:read" | "memory:write"> = [],
  workspaceTerminalScopes: ReadonlyArray<AuthMcpWorkspaceTerminalScope> = [],
): ReadonlyArray<AuthEnvironmentScope> => [
  ...new Set([
    ...memoryScopes,
    ...workspaceTerminalScopes,
    ...(access === "read-only"
      ? [AuthOrchestrationReadScope]
      : access === "full-access"
        ? [
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
            AuthSettingsWriteScope,
            AuthSourceControlWriteScope,
          ]
        : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
  ]),
];
