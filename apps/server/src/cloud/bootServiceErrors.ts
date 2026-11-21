import * as Schema from "effect/Schema";

import type { BootServiceBaseDirUnsupportedError } from "./systemdPath.ts";

export class BootServiceUnsupportedError extends Schema.TaggedError<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd and macOS with launchd; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedError<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class BootServiceInstallError extends Schema.TaggedError<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the GOAT background service.";
  }
}

export const BootServiceProblem = Schema.Literals([
  "user-manager-unavailable",
  "linger-unavailable",
  "linger-disabled",
  "service-disabled",
  "service-stopped",
  "restart-pending",
]);
export type BootServiceProblem = typeof BootServiceProblem.Type;

export function formatBootServiceProblem(problem: BootServiceProblem): string {
  switch (problem) {
    case "user-manager-unavailable":
      return "Cannot reach the systemd user manager. Run `systemctl --user status` in a login session for the service user. Install your distribution's systemd user-session support if it is missing; do not run GOAT with sudo.";
    case "linger-unavailable":
      return 'Cannot check whether this user can run services after logout. Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.';
    case "linger-disabled":
      return 'Lingering is disabled. GOAT will stop when your last login session ends and will not start at boot. Run `sudo loginctl enable-linger "$(id -un)"` on this machine, then retry the service command as your normal user.';
    case "service-disabled":
      return "The service is not enabled to start automatically. Run `goat service install` to repair it.";
    case "service-stopped":
      return "The service is not running. Check the service log and `systemctl --user status goat.service`, then run `goat service install`.";
    case "restart-pending":
      return "A newer version is installed but the service is still running the previous one. Run `goat service restart` to switch.";
  }
}

export class BootServicePrerequisiteError extends Schema.TaggedError<BootServicePrerequisiteError>()(
  "BootServicePrerequisiteError",
  { problem: BootServiceProblem, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `[${this.problem}] ${formatBootServiceProblem(this.problem)}`;
  }
}

export class BootServiceUpdatePendingError extends Schema.TaggedError<BootServiceUpdatePendingError>()(
  "BootServiceUpdatePendingError",
  { recoveryCommand: Schema.optional(Schema.String) },
) {
  override get message(): string {
    if (this.recoveryCommand !== undefined) {
      return `A remote server update is still pending, but its service definition is missing. With the service stopped, run this on the server machine: ${this.recoveryCommand}\nWait for the update to finish or roll back, stop the foreground launcher with Ctrl-C, then retry the install.`;
    }
    return "A remote server update is still pending. Wait for it to finish, then retry.";
  }
}

export class BootServiceDowngradeRefusedError extends Schema.TaggedError<BootServiceDowngradeRefusedError>()(
  "BootServiceDowngradeRefusedError",
  {
    installedVersion: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to replace goat@${this.installedVersion} with older goat@${this.targetVersion}. Run the command again with --allow-downgrade to continue.`;
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceBaseDirUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError
  | BootServicePrerequisiteError
  | BootServiceUpdatePendingError
  | BootServiceDowngradeRefusedError;
