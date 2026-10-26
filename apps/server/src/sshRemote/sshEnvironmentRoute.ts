import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  RuntimeMode,
  SshRuntimePendingReplacement,
} from "@goat/contracts";
import { targetConnectionKey } from "@goat/ssh/command";

import packageJson from "../../package.json" with { type: "json" };
import type { AcpMcpBridgeError } from "../mcp/AcpMcpStdioBridge.ts";

export const isUnknownToolRefusal = (error: AcpMcpBridgeError, tool: string) =>
  error.kind === "rpc" &&
  (error.message.includes(`Tool '${tool}' not found`) ||
    error.message.includes(`Unknown tool: ${tool}`));

export function missingRemoteToolMessage(
  host: string,
  tool: string,
  remoteVersion: string | undefined,
): string {
  return `GOAT on ${host} does not have ${tool}; it runs ${remoteVersion ?? "an older build"} and this machine runs ${packageJson.version}. Update GOAT on ${host}; a runtime this machine installed there is refreshed once that host is idle.`;
}

export function remoteVersionNote(
  host: string,
  remoteVersion: string | undefined,
  localVersion: string,
): string | null {
  if (remoteVersion === undefined || remoteVersion === localVersion) return null;
  return `GOAT on ${host} runs ${remoteVersion}; this machine runs ${localVersion}. Both speak the same protocols, but a tool or launch option added in the newer build can be missing on the older one.`;
}

export const sessionKey = (
  target: DesktopSshEnvironmentTarget,
  ceiling: RuntimeMode,
  approvals: boolean,
  memoryGrantCeiling: import("@goat/contracts").MemoryTaskGrantCeiling = "none",
  providersManage = false,
  settingsWrite = false,
  environmentId?: EnvironmentId | null,
) =>
  `${targetConnectionKey(target)}\u0000${environmentId ?? "primary"}\u0000${ceiling}\u0000${memoryGrantCeiling}${approvals ? "\u0000approvals" : ""}${providersManage ? "\u0000providers" : ""}${settingsWrite ? "\u0000settings" : ""}`;

export const shouldRetryOtherDatabase = (
  call: {
    readonly tool: string;
    readonly writes: boolean;
    readonly arguments: Readonly<Record<string, unknown>>;
  },
  remoteCode: string | undefined,
) =>
  !call.writes &&
  remoteCode === "thread_not_found" &&
  typeof call.arguments.threadId === "string" &&
  [
    "goat_thread_read",
    "goat_thread_wait",
    "goat_thread_status",
    "goat_pending_request_list",
  ].includes(call.tool);

export function pendingRuntimeMessage(alias: string, pending: SshRuntimePendingReplacement) {
  if (pending.detail === "recovery-stale")
    return `${alias}'s recovery is locked. Remove ~/.goat/ssh-launch/replacement.recovery on the remote host after checking that no GOAT client is replacing this runtime.`;
  if (pending.reason === "contended")
    return `Another client is replacing ${alias}'s GOAT runtime; retry later`;
  const why =
    pending.replacement === "capability"
      ? `GOAT ${pending.liveVersion} cannot grant memory access to tasks, so `
      : "";
  return pending.reason === "unknown"
    ? `${why}${alias}'s GOAT runtime is waiting for a verified idle response before replacement; retry later`
    : `${why}${alias}'s GOAT runtime is being replaced when its current work finishes; retry later`;
}
