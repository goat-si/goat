import {
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  type AtomCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "@goat/client-runtime/state/runtime";
import { type EnvironmentId, NotesEvent, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { subscribe, type EnvironmentSubscriptionRpcTag } from "@goat/client-runtime/rpc";

import { connectionAtomRuntime } from "../../connection/runtime";
import { emptyNoteIndex, reduceNoteIndex } from "../../notes/noteState";

export const notesRpc = {
  read: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notes:read",
    tag: WS_METHODS.notesRead,
  }),
  write: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notes:write",
    tag: WS_METHODS.notesWrite,
  }),
  move: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notes:move",
    tag: WS_METHODS.notesMove,
  }),
  delete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notes:delete",
    tag: WS_METHODS.notesDelete,
  }),
  update: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notes:update",
    tag: WS_METHODS.notesUpdate,
  }),
  startWork: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notes:start-work",
    tag: WS_METHODS.notesStartWork,
  }),
  workTargets: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notes:work-targets",
    tag: WS_METHODS.notesWorkTargets,
  }),
  workTargetProjects: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notes:work-target-projects",
    tag: WS_METHODS.notesWorkTargetProjects,
  }),
};

// Notes reads are guarded RPCs, so keep the command's permission checks inside the
// connection-aware query.
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
  read: noteQuery(notesRpc.read),
  workTargets: noteQuery(notesRpc.workTargets),
  workTargetProjects: noteQuery(notesRpc.workTargetProjects),
};

export function retryFailedNoteRead(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  path: string,
) {
  const atom = notesQueries.read({ environmentId, input: { path } });
  const result = registry.get(atom);
  if (result._tag === "Failure" && !result.waiting) registry.refresh(atom);
}

const decodeNotesEvent = Schema.decodeUnknownSync(NotesEvent);
export const notesSubscription = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "notes:subscription",
  idleTtlMs: 0,
  // The shared tag union omits notes.subscribe. Validate its events here while retaining the
  // shared transport's session switching, retry policy and subscription cleanup.
  subscribe: (_input: Record<string, never>) =>
    subscribe(WS_METHODS.notesSubscribe as EnvironmentSubscriptionRpcTag, {}).pipe(
      Stream.map((event) => decodeNotesEvent(event)),
      Stream.scan(() => emptyNoteIndex, reduceNoteIndex),
    ),
});
