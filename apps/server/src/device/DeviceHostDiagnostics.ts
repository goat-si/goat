import * as Schema from "effect/Schema";
import { DeviceToolchainInstallError } from "./DeviceToolchain.ts";
import { SshCommandError } from "@goat/ssh/errors";
import { sshAuthenticationFailure, sshLocalProxyFailure } from "@goat/shared/sshFailure";
import type { DeviceHostError } from "./DeviceHost.ts";
import { isSshWindowsHostError } from "./SshDeviceHost.ts";

export function sshProbeFailureMessage(error: DeviceHostError): string {
  const windows = isSshWindowsHostError(error.cause) ? error.cause : null;
  const cause = windows ? windows.cause : error.cause;
  if (cause instanceof SshCommandError && cause.exitCode === 255) {
    const text = cause.stderr;
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(text))
      return "SSH found a changed host key. Verify the host's identity before removing its old key and reconnecting.";
    if (/host key verification failed|no .* host key is known|authenticity of host/iu.test(text))
      return "SSH could not verify the host key. Verify the host's identity and accept its key from the machine running GOAT.";
    const proxy = sshLocalProxyFailure(text);
    if (proxy !== undefined) return proxy.fix;
    if (sshAuthenticationFailure(text) !== undefined)
      return "SSH login failed. Ensure the machine running GOAT can authenticate without an interactive prompt.";
    if (/^ssh: Could not resolve hostname /imu.test(text))
      return "Could not resolve the SSH host name. Check its address and DNS configuration.";
    if (/^ssh: connect to host /imu.test(text))
      return "Could not reach the SSH host. Check that it is online and its SSH address and port are correct.";
    return "Could not connect to this host over SSH.";
  }
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
