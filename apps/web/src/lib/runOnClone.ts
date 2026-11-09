import { scopeProjectRef } from "@goat/client-runtime/environment";
import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import type { ScopedProjectRef } from "@goat/contracts";

import { waitForProject } from "../state/entities";
import { type AddProjectToMachineInput, addProjectToMachine } from "./addProjectToMachine";

export interface RunOnClone {
  readonly ref: ScopedProjectRef;
  /** The cloned project once this client has it, or null if it did not arrive in time. */
  readonly arrived: Promise<EnvironmentProject | null>;
}

const pending = new Map<string, Promise<RunOnClone>>();

/**
 * Starts a clone picked under Run on. Until its project reaches this client, another pick of
 * the same repository, machine and folder shares it. Anything else goes to the server, which
 * refuses a second clone into a folder it is still cloning into.
 */
export function cloneForRunOn(input: AddProjectToMachineInput): Promise<RunOnClone> {
  const key = [input.target.environmentId, input.destinationPath, input.remoteUrl].join("\n");
  const existing = pending.get(key);
  if (existing) return existing;
  const ref = scopeProjectRef(input.target.environmentId, input.projectId);
  const started = addProjectToMachine(input).then(() => ({
    ref,
    arrived: waitForProject(ref).catch(() => null),
  }));
  pending.set(key, started);
  void started
    .then(
      (clone) => clone.arrived,
      () => null,
    )
    .finally(() => pending.delete(key));
  return started;
}
