import {
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "@goat/client-runtime/state/runtime";
import { WS_METHODS } from "@goat/contracts";
import { followNotesSessions } from "./subscription";
import { noteSubscriptionSessions } from "@goat/client-runtime/notes/rpc";
import { Atom, AsyncResult } from "effect/reactivity";
import { connectionAtomRuntime } from "../../../connection/runtime";

import { type NotesFeed } from "../notes-model";

const readNotes = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "notes:read",
  tag: WS_METHODS.notesRead,
});

export const notesRpc = {
  list: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notes:list",
    tag: WS_METHODS.notesList,
  }),
  read: readNotes,
  write: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notes:write",
    tag: WS_METHODS.notesWrite,
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
  feed: (() => {
    const stream = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
      label: "notes:feed",
      subscribe: (_input: {}) => followNotesSessions(noteSubscriptionSessions),
    });
    const family = Atom.family((environmentId: import("@goat/contracts").EnvironmentId) =>
      Atom.make((get) =>
        get(readNotes.permissionAtom(environmentId))
          ? get(stream({ environmentId, input: {} }))
          : AsyncResult.initial<NotesFeed>(),
      ),
    );
    return (target: {
      readonly environmentId: import("@goat/contracts").EnvironmentId;
      readonly input: {};
    }) => family(target.environmentId);
  })(),
};
