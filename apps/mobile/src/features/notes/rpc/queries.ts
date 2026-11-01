import {
  createEnvironmentQueryAtomFamily,
  type AtomCommand,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { notesRpc } from "./notes";

// Discovery reads retain command permissions while the query waits for a session
// and repeats the read when that session is replaced.
function noteQuery<Input, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: Input }, A, E>,
) {
  const query = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    label: `${command.label}:query`,
    idleTtlMs: 0,
    execute: (target: { environmentId: EnvironmentId; input: Input }) =>
      Effect.gen(function* () {
        const registry = yield* AtomRegistry.AtomRegistry;
        const result = yield* Effect.promise(() => command.run(registry, target));
        return result._tag === "Success" ? result.value : yield* Effect.failCause(result.cause);
      }),
  });
  return (target: { environmentId: EnvironmentId; input: Input }) =>
    query({ environmentId: target.environmentId, input: target });
}

export const notesQueries = {
  workTargets: noteQuery(notesRpc.workTargets),
  workTargetProjects: noteQuery(notesRpc.workTargetProjects),
};
