/**
 * Clients report browser profiles only when they connect, so the catalog at the last report is
 * kept on disk for agents and scheduled tasks that open a profile after a restart.
 */
import {
  BROWSER_PROFILE_MAX_COUNT,
  BrowserProfile,
  BrowserProfileId,
  isBuiltInBrowserProfileId,
} from "@goat/contracts";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/** One report holds at most 24 profiles; the saved union of clients keeps the newest 48. */
const SAVED_BROWSER_PROFILES_MAX = 2 * BROWSER_PROFILE_MAX_COUNT;

const SavedProfilesJson = Schema.fromJsonString(
  Schema.Struct({ profiles: Schema.Array(BrowserProfile), defaultProfileId: BrowserProfileId }),
);
const decodeSaved = Schema.decodeUnknownEffect(SavedProfilesJson);
const encodeSaved = Schema.encodeSync(SavedProfilesJson);

export interface SavedProfileCatalog {
  readonly profiles: ReadonlyArray<BrowserProfile>;
  readonly defaultProfileId: string;
}

/** What startup found on disk. Unreadable starts with the built-ins and says so in status. */
export type RestoredProfiles =
  | { readonly _tag: "Restored"; readonly catalog: SavedProfileCatalog }
  | { readonly _tag: "None" }
  | { readonly _tag: "Unreadable" };

const newest = (catalog: SavedProfileCatalog) => ({
  profiles: catalog.profiles
    .filter((profile) => !isBuiltInBrowserProfileId(profile.id))
    .slice(-SAVED_BROWSER_PROFILES_MAX),
  defaultProfileId: catalog.defaultProfileId,
});

export const makeSavedBrowserProfiles = Effect.fn("SavedBrowserProfiles.make")(function* (
  filePath: string,
) {
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const fs = yield* FileSystem.FileSystem;
  const lock = yield* Semaphore.make(1);
  const read = yield* fs.readFileString(filePath).pipe(
    Effect.map((contents) => ({ contents, failed: false })),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed({ contents: "", failed: false })
        : Effect.logWarning("failed to read saved browser profiles", {
            path: filePath,
            cause,
          }).pipe(Effect.as({ contents: "", failed: true })),
    ),
  );
  let saved = read.contents;
  const restored: RestoredProfiles = read.failed
    ? { _tag: "Unreadable" }
    : saved === ""
      ? { _tag: "None" }
      : yield* decodeSaved(saved).pipe(
          Effect.map((catalog): RestoredProfiles => ({
            _tag: "Restored",
            catalog: newest(catalog),
          })),
          Effect.catch((cause) =>
            Effect.logWarning("ignoring invalid saved browser profiles", {
              path: filePath,
              cause,
            }).pipe(Effect.as<RestoredProfiles>({ _tag: "Unreadable" })),
          ),
        );

  // Only reports set what is saved, so clients disconnecting at shutdown cannot shrink it.
  let pending: SavedProfileCatalog | null = null;
  const write = Effect.gen(function* () {
    if (pending === null) return;
    const contents = encodeSaved(newest(pending));
    if (contents === saved) return;
    yield* writeFileStringAtomically({ filePath, contents }).pipe(Effect.provideContext(services));
    saved = contents;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to save reported browser profiles", { path: filePath, cause }),
    ),
    lock.withPermits(1),
  );

  /** Saves the catalog as of this report; a disconnect while it waits cannot drop it. */
  const save = Effect.fn("SavedBrowserProfiles.save")(function* (catalog: SavedProfileCatalog) {
    pending = catalog;
    yield* write;
  }, Effect.uninterruptible);

  return { restored, save };
});
