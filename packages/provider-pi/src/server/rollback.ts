import type { OrchestrationV2ProviderTurn, ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { PiAdapterV2Options } from "./adapter.ts";
import * as PiConstants from "./adapterConstants.ts";
import { piSessionListing, readPiEntries, readPiSessionFile, walkPiBranch } from "./entries.ts";
import { piForkBoundary, piForkEntry } from "./forkBoundary.ts";
import { findHistoricalForkSession } from "./historicalForkSession.ts";
import type { PiRuntimeProfile } from "./profile.ts";
import {
  piRecordField as recordField,
  piRecordString as recordString,
  type PiRpcRecord,
} from "./rpc.ts";
import { sessionFileInCwd } from "./sessionCwd.ts";

export function piTurnEntryId(
  turn: OrchestrationV2ProviderTurn | null | undefined,
): string | undefined {
  const ref = turn?.nativeTurnRef;
  return ref?.strength === "strong" ? (ref.nativeId ?? undefined) : undefined;
}

export interface PiRollbackPlanResult {
  readonly changed: boolean;
  readonly forkSessionFile?: string;
  readonly entriesData?: unknown;
  readonly leafId?: string | null;
}

export const executePiRollback = Effect.fnUntraced(function* <E>({
  rollbackInput,
  currentFile,
  cwd,
  driver,
  profile,
  options,
  launchArgs,
  spawner,
  fileSystem,
  path,
  request,
  lifecycleRequest,
  protocolError,
  invalidateThreadState,
  onSessionSwitched,
}: {
  readonly rollbackInput: ProviderAdapter.ProviderAdapterV2RollbackThreadInput;
  readonly currentFile: string | null | undefined;
  readonly cwd: string;
  readonly driver: ProviderDriverKind;
  readonly profile: PiRuntimeProfile;
  readonly options: PiAdapterV2Options;
  readonly launchArgs: ReadonlyArray<string>;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly request: (
    payload: PiRpcRecord,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, E | ProviderAdapter.ProviderAdapterProtocolError>;
  readonly lifecycleRequest: (
    payload: PiRpcRecord,
  ) => Effect.Effect<unknown, E | ProviderAdapter.ProviderAdapterProtocolError>;
  readonly protocolError: (
    detail: string,
    cause?: unknown,
  ) => ProviderAdapter.ProviderAdapterProtocolError;
  readonly invalidateThreadState: () => void;
  readonly onSessionSwitched: (switched: boolean) => void;
}): Effect.fn.Return<
  PiRollbackPlanResult,
  E | ProviderAdapter.ProviderAdapterProtocolError | unknown
> {
  const target =
    rollbackInput.target.type === "provider_turn" ? rollbackInput.target.providerTurn : null;
  const targetFile = target?.nativeThreadRef?.nativeId ?? undefined;
  const firstBoundary = piForkBoundary(rollbackInput);
  const isCurrentFile = (file: string) =>
    currentFile != null && path.resolve(cwd, file) === path.resolve(cwd, currentFile);
  const boundaryFile =
    firstBoundary.type === "nothing" ? undefined : firstBoundary.turn.nativeThreadRef?.nativeId;
  let boundary = firstBoundary;
  let sourceFile = targetFile ?? boundaryFile;
  const targetId = piTurnEntryId(target);
  const readEntries = readPiEntries(profile.pagedEntries, request);
  if (
    targetFile !== undefined &&
    boundaryFile != null &&
    path.resolve(cwd, boundaryFile) !== path.resolve(cwd, targetFile)
  ) {
    // A previous fork can carry the checkpoint into the session with the discard boundary.
    const listing =
      targetId === undefined
        ? null
        : isCurrentFile(boundaryFile)
          ? piSessionListing(yield* readEntries)
          : yield* readPiSessionFile(fileSystem, path.resolve(cwd, boundaryFile));
    const boundaryId = firstBoundary.type === "entry" ? firstBoundary.entryId : null;
    if (
      targetId !== undefined &&
      listing !== null &&
      listing.entries.has(targetId) &&
      (boundaryId === null ||
        (listing.entries.has(boundaryId) &&
          walkPiBranch(listing.entries, listing.leafId, boundaryId)?.reachedStop === true)) &&
      walkPiBranch(listing.entries, boundaryId ?? listing.leafId, targetId)?.reachedStop === true
    ) {
      sourceFile = boundaryFile;
    } else {
      boundary = piForkBoundary({ ...rollbackInput, sessionFile: targetFile });
    }
  }
  if (
    sourceFile == null &&
    currentFile != null &&
    boundary.type === "entry" &&
    piTurnEntryId(boundary.target) !== undefined &&
    boundary.target?.startedAt != null &&
    boundary.target.completedAt !== null &&
    boundary.turn.completedAt !== null
  ) {
    // The persisted file avoids sending the whole tree over RPC before forking.
    const live = yield* readPiSessionFile(fileSystem, path.resolve(cwd, currentFile));
    if (live !== null && !live.entries.has(boundary.entryId)) {
      sourceFile = yield* findHistoricalForkSession(currentFile, boundary, driver).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    }
  }
  let switchedTo: string | undefined;
  if (sourceFile != null && !isCurrentFile(sourceFile)) {
    switchedTo = yield* sessionFileInCwd(fileSystem, {
      sourceFile,
      boundary: { type: "nothing" },
      createdAt: rollbackInput.providerThread.createdAt,
      cwd,
      driver,
      profile,
      options,
      launchArgs,
      spawner,
    });
    // Pi can change files before its switch response arrives.
    onSessionSwitched(true);
    const switched = yield* lifecycleRequest({
      type: "switch_session",
      sessionPath: switchedTo,
    });
    if (recordField(switched, "cancelled") === true) {
      onSessionSwitched(false);
      return yield* protocolError("A Pi extension cancelled the session switch");
    }
    const attached = recordString(yield* request({ type: "get_state" }), "sessionFile");
    if (attached === undefined || path.resolve(cwd, attached) !== path.resolve(cwd, switchedTo)) {
      return yield* protocolError("Pi rollback did not attach the source session file");
    }
  }
  let forkEntryId: string | undefined;
  if (boundary.type !== "nothing") {
    forkEntryId = yield* piForkEntry(
      driver,
      boundary,
      rollbackInput.providerThread.createdAt,
      readEntries,
    );
  } else if (switchedTo === undefined) {
    return { changed: false };
  } else {
    const listing = piSessionListing(yield* readEntries);
    const walk =
      listing !== null && targetId !== undefined && listing.entries.has(targetId)
        ? walkPiBranch(listing.entries, listing.leafId, targetId)
        : null;
    if (listing === null || walk?.reachedStop !== true)
      return yield* protocolError("Pi rollback could not verify the retained session head");
    // A move can leave prompts behind in the source file, even when no later
    // app turn points at that file. Keep steers sent during the retained turn.
    for (const id of [...walk.userEntryIds].reverse()) {
      const timestamp = listing.entries.get(id)?.timestamp;
      if (timestamp == null || target?.completedAt == null)
        return yield* protocolError("Pi rollback could not verify the retained session head");
      if (timestamp >= DateTime.toEpochMillis(target.completedAt)) {
        forkEntryId = id;
        break;
      }
    }
  }
  if (forkEntryId !== undefined) {
    const forkData = yield* lifecycleRequest({ type: "fork", entryId: forkEntryId });
    if (recordField(forkData, "cancelled") === true)
      return yield* protocolError("A Pi extension cancelled the session fork");
  }
  if (profile.driver === "omo") {
    // The fork or switch already moved the native session; never keep the old binding on failure.
    yield* request(
      { type: "prompt", message: "/computer off" },
      PiConstants.PI_SESSION_TIMEOUT_MS,
    ).pipe(Effect.onError(() => Effect.sync(invalidateThreadState)));
  }
  const forkState = yield* request({ type: "get_state" }).pipe(
    Effect.onError(() => Effect.sync(invalidateThreadState)),
  );
  const forkSessionFile = recordString(forkState, "sessionFile");
  if (forkSessionFile === undefined) {
    invalidateThreadState();
    return yield* protocolError("Pi fork did not return a persisted session file");
  }
  const entriesRead = readPiEntries(profile.pagedEntries, request);
  const entriesData = yield* profile.pagedEntries
    ? entriesRead.pipe(Effect.tapError(() => Effect.sync(invalidateThreadState)))
    : entriesRead.pipe(Effect.orElseSucceed(() => undefined));
  const leafId = recordString(entriesData, "leafId") ?? null;
  return { changed: true, forkSessionFile, entriesData, leafId };
});
