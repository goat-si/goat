import { goatclawRoleBrief } from "../goatclaw/RoleTemplates.ts";
import type { SshLaunchInput } from "./SshRemoteDispatch.ts";

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
