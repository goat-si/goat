import * as Schema from "effect/Schema";
import { DeviceToolchainInstallError } from "./DeviceToolchain.ts";
import { SshCommandError } from "@goat/ssh/errors";
import type { DeviceHostError } from "./DeviceHost.ts";
import { isSshWindowsHostError } from "./SshDeviceHost.ts";

export function sshProbeFailureMessage(error: DeviceHostError): string {
  const windows = isSshWindowsHostError(error.cause) ? error.cause : null;
  const cause = windows ? windows.cause : error.cause;
  if (
    !(cause instanceof SshCommandError) ||
    cause.exitCode === null ||
    cause.exitCode < 1 ||
    (cause.exitCode > 254 && cause.exitCode !== 9009)
  )
    return "Could not connect to this host over SSH.";
  if (
    cause.exitCode === 1 &&
    cause.stderr
      .split(/\r?\n/u)
      .some((line) => line.trim() === "Node is missing from the non-interactive SSH PATH")
  )
    return "Connected over SSH, but Node is not on this host's PATH for non-interactive SSH commands.";
  if (windows) return windows.message;
  return `Connected over SSH, but the device host check failed (exit code ${cause.exitCode}).`;
}

const isToolchainInstallError = Schema.is(DeviceToolchainInstallError);
export const actionableHostFailure = (error: DeviceHostError): string | undefined => {
  if (error.step === "probe") return sshProbeFailureMessage(error);
  if (isToolchainInstallError(error.cause) && error.cause.reason === "npm_not_found")
    return error.cause.message;
  return undefined;
};
