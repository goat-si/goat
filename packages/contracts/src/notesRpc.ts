import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  NoteConflictError,
  NoteDocument,
  NoteError,
  NotesDeleteInput,
  NotesDeleteResult,
  NotesEvent,
  NotesListInput,
  NotesListResult,
  NotesMoveInput,
  NotesReadInput,
  NotesStartWorkInput,
  NotesStartWorkResult,
  NotesSubscribeInput,
  NotesWorkTargetProjectsInput,
  NotesWorkTargetProjectsResult,
  NotesWorkTargetsInput,
  NotesWorkTargetsResult,
  NotesWriteInput,
  NotesUpdateInput,
} from "./notes.ts";

export const NOTES_WS_METHODS = {
  notesList: "notes.list",
  notesRead: "notes.read",
  notesWrite: "notes.write",
  notesUpdate: "notes.update",
  notesMove: "notes.move",
  notesDelete: "notes.delete",
  notesSubscribe: "notes.subscribe",
  notesStartWork: "notes.startWork",
  notesWorkTargets: "notes.workTargets",
  notesWorkTargetProjects: "notes.workTargetProjects",
} as const;

const NoteRpcErrors = Schema.Union([NoteError, NoteConflictError, EnvironmentAuthorizationError]);

const WsNotesListRpc = Rpc.make(NOTES_WS_METHODS.notesList, {
  payload: NotesListInput,
  success: NotesListResult,
  error: NoteRpcErrors,
});
const WsNotesReadRpc = Rpc.make(NOTES_WS_METHODS.notesRead, {
  payload: NotesReadInput,
  success: NoteDocument,
  error: NoteRpcErrors,
});
const WsNotesWriteRpc = Rpc.make(NOTES_WS_METHODS.notesWrite, {
  payload: NotesWriteInput,
  success: NoteDocument,
  error: NoteRpcErrors,
});
const WsNotesUpdateRpc = Rpc.make(NOTES_WS_METHODS.notesUpdate, {
  payload: NotesUpdateInput,
  success: NoteDocument,
  error: NoteRpcErrors,
});
const WsNotesMoveRpc = Rpc.make(NOTES_WS_METHODS.notesMove, {
  payload: NotesMoveInput,
  success: NoteDocument,
  error: NoteRpcErrors,
});
const WsNotesDeleteRpc = Rpc.make(NOTES_WS_METHODS.notesDelete, {
  payload: NotesDeleteInput,
  success: NotesDeleteResult,
  error: NoteRpcErrors,
});
const WsNotesSubscribeRpc = Rpc.make(NOTES_WS_METHODS.notesSubscribe, {
  payload: NotesSubscribeInput,
  success: NotesEvent,
  error: NoteRpcErrors,
  stream: true,
});
const WsNotesStartWorkRpc = Rpc.make(NOTES_WS_METHODS.notesStartWork, {
  payload: NotesStartWorkInput,
  success: NotesStartWorkResult,
  error: NoteRpcErrors,
});
const WsNotesWorkTargetsRpc = Rpc.make(NOTES_WS_METHODS.notesWorkTargets, {
  payload: NotesWorkTargetsInput,
  success: NotesWorkTargetsResult,
  error: NoteRpcErrors,
});
const WsNotesWorkTargetProjectsRpc = Rpc.make(NOTES_WS_METHODS.notesWorkTargetProjects, {
  payload: NotesWorkTargetProjectsInput,
  success: NotesWorkTargetProjectsResult,
  error: NoteRpcErrors,
});

/** rpc.ts adds scope authorization, which lives there, when it publishes WsNotesRpcGroup. */
export const NotesRpcs = RpcGroup.make(
  WsNotesListRpc,
  WsNotesReadRpc,
  WsNotesWriteRpc,
  WsNotesUpdateRpc,
  WsNotesMoveRpc,
  WsNotesDeleteRpc,
  WsNotesSubscribeRpc,
  WsNotesStartWorkRpc,
  WsNotesWorkTargetsRpc,
  WsNotesWorkTargetProjectsRpc,
);
