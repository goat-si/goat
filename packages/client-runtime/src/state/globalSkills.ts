import { GLOBAL_SKILLS_WS_METHODS } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createGlobalSkillsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:remove",
      tag: GLOBAL_SKILLS_WS_METHODS.globalRemove,
    }),
    rescan: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:rescan",
      tag: GLOBAL_SKILLS_WS_METHODS.globalRescan,
    }),
  };
}
