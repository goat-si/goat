import type { ConnectionOnboarding } from "@goat/client-runtime/connection";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type {
  DesktopSshEnvironmentTarget,
  DesktopSshPreparationProgress,
  EnvironmentId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { sshRuntime } from "~/state/sshRuntime";
import {
  formatDesktopSshConnectionError,
  isSshConnectionSuperseded,
} from "./ConnectionsSettings.logic";
import type { PendingSshAddOutcome } from "./pendingSshAdds";

/** One Add device SSH connect, reduced to what its pending Connections row shows. */
export async function runSshAdd(
  connect: (
    input: ConnectionOnboarding.SshConnectionInput,
  ) => Promise<AtomCommandResult<unknown, unknown>>,
  input: {
    readonly environmentId: EnvironmentId;
    readonly target: DesktopSshEnvironmentTarget;
    readonly expectedEnvironmentId: EnvironmentId | null;
    readonly report: (progress: DesktopSshPreparationProgress) => void;
  },
): Promise<PendingSshAddOutcome> {
  const { target } = input;
  const result = await connect({
    target,
    label: "",
    onPreparationProgress: (progress) => Effect.sync(() => input.report(progress)),
    ...(target.alias.startsWith("goat-") ? { keyOnly: true } : {}),
    ...(input.expectedEnvironmentId ? { expectedEnvironmentId: input.expectedEnvironmentId } : {}),
  });
  if (result._tag === "Success") return { _tag: "connected" };
  const error = squashAtomCommandFailure(result);
  if (isAtomCommandInterrupted(result) || isSshConnectionSuperseded(error)) {
    return { _tag: "dropped" };
  }
  const message = formatDesktopSshConnectionError(error);
  const current = await sshRuntime.refresh.run(appAtomRegistry, {
    environmentId: input.environmentId,
    target,
  });
  return {
    _tag: "failed",
    message:
      current._tag === "Success" && current.value?.status?.state === "ready"
        ? `GOAT is ready on ${target.alias}, but the connection couldn't be saved. ${message}`
        : message,
  };
}
