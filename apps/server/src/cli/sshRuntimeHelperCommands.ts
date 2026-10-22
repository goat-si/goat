import {
  activity,
  commitTime,
  compareVersion,
  compat,
  drain,
  protocol,
  runtimeManifest,
} from "./sshRuntimeProbes.ts";
import { supervise } from "./sshRuntimeSupervisor.ts";

export {
  isLinuxZombie,
  ownSshRuntimeProtocol,
  readLiveSshRuntimeProtocol,
  readSshRuntimeCompatibility,
  readSshServerActivity,
  requestSshRuntimeDrain,
  RUNTIME_DRAIN_AUTOMATIC_ENV,
} from "./sshRuntimeProbes.ts";
export {
  readSshReplacementRecord,
  SSH_REPLACEMENT_RECORD_FILE,
  superviseSshRuntimeReplacement,
  type SshRuntimeSupervisorInput,
  type SshRuntimeSupervisorResult,
} from "./sshRuntimeSupervisor.ts";

/** GOAT runtime subcommands of `__ssh-helper`: protocol checks, drain and replacement. */
export const sshRuntimeHelperCommands = [
  protocol,
  runtimeManifest,
  activity,
  compareVersion,
  commitTime,
  compat,
  drain,
  supervise,
] as const;
