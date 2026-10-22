import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  NotesListInput,
  NotesListResult,
  NotesReadInput,
  NotesWriteInput,
  NotesUpdateInput,
  NotesMoveInput,
  NoteDocument,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Notes from "../../../notes/NotesService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Invocation.McpInvocationContext,
    Threads.ThreadManagementService,
    Notes.NotesService,
  ],
};
const list = Tool.make(agentSurfaceRegistry["note.list"].name, {
  ...shared,
  parameters: NotesListInput,
  success: NotesListResult,
  description: agentSurfaceRegistry["note.list"].description,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["note.list"]));
const read = Tool.make(agentSurfaceRegistry["note.read"].name, {
  ...shared,
  parameters: NotesReadInput,
  success: NoteDocument,
  description: agentSurfaceRegistry["note.read"].description,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["note.read"]));
const write = Tool.make(agentSurfaceRegistry["note.write"].name, {
  ...shared,
  parameters: NotesWriteInput,
  success: NoteDocument,
  description: agentSurfaceRegistry["note.write"].description,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["note.write"]));
const update = Tool.make(agentSurfaceRegistry["note.update"].name, {
  ...shared,
  parameters: NotesUpdateInput,
  success: NoteDocument,
  description: agentSurfaceRegistry["note.update"].description,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["note.update"]));
const move = Tool.make(agentSurfaceRegistry["note.move"].name, {
  ...shared,
  parameters: NotesMoveInput,
  success: NoteDocument,
  description: agentSurfaceRegistry["note.move"].description,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["note.move"]));
export const NoteToolkit = Toolkit.make(list, read, write, update, move);
