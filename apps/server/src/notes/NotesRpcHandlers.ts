import { WS_METHODS, WsNotesRpcGroup } from "@goat/contracts";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as Effect from "effect/Effect";
import { NoteWorkService } from "./NoteWorkService.ts";
import { NotesService } from "./NotesService.ts";

export const ServerWsNotesRpcGroup = WsNotesRpcGroup.middleware(RpcInstrumentation);

/** The notes RPC transport: each method calls one service method. */
const makeNoteRpcHandlers = (
  notes: NotesService["Service"],
  noteWork: NoteWorkService["Service"],
  surface: "mobile" | "web",
) =>
  ServerWsNotesRpcGroup.of({
    [WS_METHODS.notesList]: (input) => notes.list(input),
    [WS_METHODS.notesRead]: (input) => notes.read(input),
    [WS_METHODS.notesWrite]: (input) => notes.write(input, "user"),
    [WS_METHODS.notesUpdate]: (input) => notes.update(input),
    [WS_METHODS.notesMove]: (input) => notes.move(input, "user"),
    [WS_METHODS.notesDelete]: (input) => notes.delete(input),
    [WS_METHODS.notesSubscribe]: () => notes.subscribe,
    [WS_METHODS.notesStartWork]: (input) => noteWork.startWork(input, surface),
    [WS_METHODS.notesWorkTargets]: () => noteWork.workTargets,
    [WS_METHODS.notesWorkTargetProjects]: (input) => noteWork.workTargetProjects(input),
    [WS_METHODS.notesAttach]: (input) => notes.attach(input),
  });

export const makeNoteRpcHandlersForSurface = Effect.fn("Notes.handlers")(function* (
  surface: "mobile" | "web",
) {
  return makeNoteRpcHandlers(yield* NotesService, yield* NoteWorkService, surface);
});
