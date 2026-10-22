import * as Layer from "effect/Layer";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Notes from "./NotesService.ts";
import * as Git from "./NotesGit.ts";
import * as Results from "./NoteResults.ts";
import * as Work from "./NoteWorkService.ts";
import * as AutoDone from "./NoteAutoDone.ts";

export const layer = Work.layer.pipe(
  Layer.provideMerge(AutoDone.layer),
  // update checks that a linked local thread exists.
  Layer.provideMerge(Notes.layer.pipe(Layer.provide(Projections.layer))),
  Layer.provideMerge(Results.layer),
  Layer.provide(Git.layer),
);
