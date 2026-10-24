import { type DecisionListInput, type EnvironmentId, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";

export function createDecisionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const revision = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const listDecisions = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:decision:list",
    tag: WS_METHODS.decisionList,
  });
  const refreshTrigger = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => ({
      allowed: get(listDecisions.permissionAtom(environmentId)),
      revision: get(revision(environmentId)),
    })),
  );
  const queryDecisions = Effect.fn("DecisionInbox.list")(function* (target: {
    environmentId: EnvironmentId;
    input: DecisionListInput;
  }) {
    const registry = yield* AtomRegistry.AtomRegistry;
    const result = yield* Effect.promise(() => listDecisions.run(registry, target));
    return result._tag === "Success" ? result.value : yield* Effect.failCause(result.cause);
  });
  const decisionItems = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:decision:list:query",
    idleTtlMs: 0,
    execute: (target: { environmentId: EnvironmentId; input: DecisionListInput }) =>
      queryDecisions(target),
    refreshTrigger: (target) => refreshTrigger(target.environmentId),
  });

  return {
    decisionItems: (target: { environmentId: EnvironmentId; input: DecisionListInput }) =>
      decisionItems({ environmentId: target.environmentId, input: target }),
    getDecision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:decision:get",
      tag: WS_METHODS.decisionGet,
    }),
    answerDecision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:decision:answer",
      tag: WS_METHODS.decisionAnswer,
      onSuccess: (target, registry) =>
        Effect.sync(() => registry.update(revision(target.environmentId), (value) => value + 1)),
    }),
  };
}
