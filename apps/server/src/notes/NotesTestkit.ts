import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Config from "../config.ts";
import * as Notes from "./NotesService.ts";
import * as Results from "./NoteResults.ts";
import * as Git from "./NotesGit.ts";

export const testScope = {
  environmentId: EnvironmentId.make("notes-test"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 0,
  requestNamespace: "notes-test",
  thread: undefined,
  client: { sessionId: "test", label: "test", access: "full-access" as const },
};
export const notesLayer = (
  latest: Results.NoteResults["Service"]["latest"] = () => Effect.succeed(null),
  changes: Stream.Stream<import("@goat/contracts").NoteThreadLink> = Stream.never,
  transformFs: (fs: FileSystem.FileSystem) => FileSystem.FileSystem = (fs) => fs,
  getThread: Projections.ProjectionStoreV2["Service"]["getThread"] = (threadId) =>
    Effect.fail(new Projections.ProjectionStoreThreadNotFoundError({ threadId })),
) =>
  Notes.layer.pipe(
    Layer.provide(Layer.mock(Projections.ProjectionStoreV2)({ getThread })),
    Layer.provideMerge(
      Layer.succeed(Results.NoteResults, {
        latest,
        remember: () => Effect.void,
        scope: testScope,
        subscribeChanges: Effect.succeed(changes),
      }),
    ),
    Layer.provide(Layer.succeed(Git.NotesGit, { changed: Effect.void, flush: Effect.void })),
    Layer.provideMerge(Config.layerTest("/tmp", { prefix: "goat-notes-test-" })),
    Layer.provideMerge(
      Layer.effectContext(
        Effect.gen(function* () {
          const context = yield* Layer.build(NodeServices.layer);
          return Context.add(
            context,
            FileSystem.FileSystem,
            transformFs(Context.get(context, FileSystem.FileSystem)),
          );
        }),
      ),
    ),
  );
