import type * as Path from "effect/Path";
import type * as Duration from "effect/Duration";
import type { BootServiceManager, BootServiceNames, BootServicePlan } from "./bootService.ts";

export function systemdManager(input: {
  readonly path: Path.Path;
  readonly unitDir: string;
  readonly names: BootServiceNames;
  readonly render: (plan: BootServicePlan, names: BootServiceNames) => string;
  readonly stopTimeout: Duration.Duration;
}): BootServiceManager {
  const unitPath = input.path.join(input.unitDir, input.names.unitFile);
  const resetFailed = {
    step: "clearing the service's failed state",
    optional: true,
    command: "systemctl",
    args: ["--user", "reset-failed", input.names.unitFile],
  };
  const prepareActivation = [
    {
      step: "reloading systemd user units",
      command: "systemctl",
      args: ["--user", "daemon-reload"],
    },
    {
      step: "enabling the service",
      command: "systemctl",
      args: ["--user", "enable", input.names.unitFile],
    },
    resetFailed,
  ];
  return {
    kind: "systemd",
    unitPath,
    render: (plan) => input.render(plan, input.names),
    stop: [
      {
        step: "stopping the installed service",
        command: "systemctl",
        args: ["--user", "stop", input.names.unitFile],
        timeout: input.stopTimeout,
      },
    ],
    activate: [
      ...prepareActivation,
      {
        step: "starting the service",
        command: "systemctl",
        args: ["--user", "restart", input.names.unitFile],
      },
    ],
    restart: [
      resetFailed,
      {
        step: "restarting the service after a failed update",
        command: "systemctl",
        args: ["--user", "restart", input.names.unitFile],
      },
    ],
    handoff: [
      ...prepareActivation,
      {
        step: "restarting the service",
        command: "systemctl",
        args: ["--user", "restart", "--no-block", input.names.unitFile],
      },
    ],
    deactivate: [
      {
        step: "stopping the service",
        command: "systemctl",
        args: ["--user", "disable", "--now", input.names.unitFile],
        timeout: input.stopTimeout,
      },
    ],
    finalize: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
    ],
  };
}
