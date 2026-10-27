import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
} from "@goat/contracts";

export const mcpClientScopes = (
  access: AuthMcpClientAccess,
  memoryScopes: ReadonlyArray<"memory:read" | "memory:write"> = [],
): ReadonlyArray<AuthEnvironmentScope> => [
  ...new Set([
    ...memoryScopes,
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
