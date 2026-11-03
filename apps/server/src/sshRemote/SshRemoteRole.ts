import { goatclawRoleBrief } from "../goatclaw/RoleTemplates.ts";
import type { SshLaunchInput } from "./SshRemoteDispatch.ts";

export const remoteRoleRefusal = (
  input: SshLaunchInput,
  declared: ReadonlySet<string> | undefined,
) =>
  input.permissionProfileCeiling !== undefined && declared?.has("permissionProfileCeiling") !== true
    ? {
        remoteCode: "permission_profile_unsupported",
        message:
          "Remote GOAT cannot preserve a permission profile ceiling; enable goatclaw on an updated destination.",
      }
    : {
        remoteCode: "role_unsupported",
        message: "Remote GOAT cannot preserve the goatclaw role; update the destination.",
      };

export const remoteRoleMessage = (input: SshLaunchInput, forwardReport: boolean) => {
  const rolePrefix =
    input.goatclawRole === undefined ? undefined : goatclawRoleBrief(input.goatclawRole, "");
  const task =
    rolePrefix !== undefined && input.message?.startsWith(rolePrefix)
      ? input.message.slice(rolePrefix.length)
      : input.message;
  return forwardReport && input.reportNote !== undefined && task?.trim()
    ? `${task}\n\n${input.reportNote}`
    : task;
};
