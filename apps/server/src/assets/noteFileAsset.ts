import {
  AssetPreviewTypeValidationError,
  AssetWorkspaceAssetNotFoundError,
  type AssetResource,
  NOTE_ATTACHMENTS_FOLDER,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { issueAssetUrl } from "./AssetAccess.ts";

type NoteFileResource = Extract<AssetResource, { readonly _tag: "note-file" }>;

// Embedded note files open inline only as media or PDF; anything else is a download.
const INLINE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".pdf",
]);
// Exact-file media claims never read the thread; this only satisfies the media resource shape.
const NOTES_THREAD = ThreadId.make("notes");

/**
 * Signs a URL for a file embedded in a note. The schema already confines the path to the notes
 * attachment folder; here the folder must be a real directory in the notes root and the file a
 * direct child of it, then the exact-file media path serves it with its identity checks.
 */
export const issueNoteFileUrl = Effect.fn("AssetAccess.issueNoteFileUrl")(function* (
  resource: NoteFileResource,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { notesDir } = yield* ServerConfig.ServerConfig;
  const notFound = new AssetWorkspaceAssetNotFoundError({ resource });
  if (
    resource.disposition !== "attachment" &&
    !INLINE_EXTENSIONS.has(path.extname(resource.path).toLowerCase())
  )
    return yield* new AssetPreviewTypeValidationError({ resource });
  const real = (target: string) => fs.realPath(target).pipe(Effect.mapError(() => notFound));
  const folder = path.join(yield* real(notesDir), NOTE_ATTACHMENTS_FOLDER);
  if ((yield* real(folder)) !== folder) return yield* notFound;
  const file = yield* real(path.join(folder, path.basename(resource.path)));
  if (path.dirname(file) !== folder) return yield* notFound;
  return yield* issueAssetUrl({
    resource: {
      _tag: "media-file",
      threadId: NOTES_THREAD,
      path: file,
      ...(resource.disposition ? { disposition: resource.disposition } : {}),
    },
  }).pipe(
    // Report against the note's own resource, never the server path it resolved to.
    Effect.mapError((error) =>
      error._tag === "AssetPreviewTypeValidationError"
        ? new AssetPreviewTypeValidationError({ resource })
        : notFound,
    ),
  );
});
