import type { OrchestrationV2ProviderTurn, ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { PiAdapterV2Options } from "./adapter.ts";
import * as PiConstants from "./adapterConstants.ts";
import {
  piRetainedCheckpoint,
  piSameHistory,
  piSessionListing,
  readPiEntries,
  readPiSessionFile,
  walkPiBranch,
  type PiHistoricalCheckpoint,
} from "./entries.ts";
import { piForkBoundary, piForkEntry } from "./forkBoundary.ts";
import {
  findHistoricalCheckpointSession,
  findHistoricalForkSession,
} from "./historicalForkSession.ts";
import type { PiRuntimeProfile } from "./profile.ts";
import {
  piRecordField as recordField,
  piRecordString as recordString,
  type PiRpcRecord,
} from "./rpc.ts";
import { sessionFileInCwd } from "./sessionCwd.ts";

function piTurnEntryId(turn: OrchestrationV2ProviderTurn | null | undefined): string | undefined {
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
}) {
  const target =
    rollbackInput.target.type === "provider_turn" ? rollbackInput.target.providerTurn : null;
  const targetFile = target?.nativeThreadRef?.nativeId ?? undefined;
  const firstBoundary = piForkBoundary(rollbackInput);
  const isCurrentFile = (file: string) =>
    currentFile != null && path.resolve(cwd, file) === path.resolve(cwd, currentFile);
  const targetPath = targetFile === undefined ? undefined : path.resolve(cwd, targetFile);
  const isTargetFile = (file: string | null | undefined) =>
    file != null && path.resolve(cwd, file) === targetPath;
  const boundaryFile =
    firstBoundary.type === "nothing" ? undefined : firstBoundary.turn.nativeThreadRef?.nativeId;
  let boundary = firstBoundary;
  let sourceFile = targetFile ?? boundaryFile;
  let recoveredLegacySource: PiHistoricalCheckpoint | undefined;
  const targetId = piTurnEntryId(target);
  const readEntries = readPiEntries(profile.pagedEntries, request);
  const readCurrentEntries = yield* Effect.cached(readEntries);
  if (targetFile !== undefined && boundaryFile != null && !isTargetFile(boundaryFile)) {
    // A previous fork can carry the checkpoint into the session with the discard boundary.
    const listing =
      targetId === undefined
        ? null
        : isCurrentFile(boundaryFile)
          ? piSessionListing(yield* readCurrentEntries)
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
        Effect.catchIf(
          (error) =>
            error.detail.startsWith("Cannot recover Pi fork session: no verified sibling session"),
          () => Effect.succeed(null),
        ),
      );
    }
  }
  const candidateFile = sourceFile ?? currentFile;
  if (
    targetFile === undefined &&
    candidateFile != null &&
    targetId !== undefined &&
    target?.startedAt != null &&
    target.completedAt !== null
  ) {
    const resolvedCandidate = path.resolve(cwd, candidateFile);
    const listing = isCurrentFile(candidateFile)
      ? piSessionListing(yield* readCurrentEntries)
      : yield* readPiSessionFile(fileSystem, resolvedCandidate);
    if (listing === null)
      return yield* protocolError("Pi rollback could not verify the retained session head");
    const boundaryId = boundary.type === "entry" ? boundary.entryId : undefined;
    if (
      !listing.entries.has(targetId) ||
      (boundaryId === undefined
        ? walkPiBranch(listing.entries, listing.leafId, targetId)?.reachedStop !== true
        : !listing.entries.has(boundaryId))
    ) {
      const previousTurn = rollbackInput.providerThreadTurns
        .filter((turn) => turn.ordinal < target.ordinal)
        .sort((a, b) => b.ordinal - a.ordinal)[0];
      const earliestPromptAt = previousTurn?.completedAt ?? rollbackInput.providerThread.createdAt;
      recoveredLegacySource = yield* findHistoricalCheckpointSession(
        resolvedCandidate,
        targetId,
        DateTime.min(earliestPromptAt, target.startedAt),
        target.completedAt,
        driver,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      if (recoveredLegacySource === undefined)
        return yield* protocolError("Pi rollback entry was not found in a session");
      sourceFile = recoveredLegacySource.file;
      boundary = { type: "nothing" };
    } else if (
      boundaryId !== undefined &&
      (boundaryId === targetId ||
        walkPiBranch(listing.entries, boundaryId, targetId)?.reachedStop !== true)
    ) {
      return yield* protocolError("Pi rollback could not verify the retained session head");
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
  const leftTargetFile =
    target !== null &&
    isTargetFile(sourceFile) &&
    rollbackInput.providerThreadTurns.some((turn) => {
      const file = turn.nativeThreadRef?.nativeId;
      return turn.ordinal > target.ordinal && file != null && !isTargetFile(file);
    });
  const verifySource = leftTargetFile || (boundary.type === "nothing" && switchedTo !== undefined);
  if (boundary.type === "nothing" && !verifySource && recoveredLegacySource === undefined) {
    return { changed: false };
  }
  let forkEntryId: string | undefined;
  let sourceEntries = switchedTo === undefined ? readCurrentEntries : readEntries;
  if (recoveredLegacySource !== undefined) {
    const listing = piSessionListing(yield* sourceEntries);
    const completedAt = target?.completedAt;
    const retained =
      listing !== null && targetId !== undefined
        ? piRetainedCheckpoint(
            listing,
            targetId,
            completedAt == null ? undefined : DateTime.toEpochMillis(completedAt),
          )
        : undefined;
    if (
      listing === null ||
      retained === undefined ||
      !piSameHistory(
        listing,
        retained.headId,
        recoveredLegacySource.listing,
        recoveredLegacySource.retained.headId,
      )
    )
      return yield* protocolError("Pi rollback could not verify the retained session head");
    forkEntryId = retained.forkEntryId;
  } else if (verifySource) {
    const data = yield* sourceEntries;
    sourceEntries = Effect.succeed(data);
    const listing = piSessionListing(data);
    // Without a captured checkpoint prompt, verify back to an earlier retained
    // prompt in the same file or to the root if none was captured.
    const anchorId =
      targetId ??
      piTurnEntryId(
        rollbackInput.providerThreadTurns
          .filter(
            (turn) =>
              target !== null &&
              turn.ordinal < target.ordinal &&
              isTargetFile(turn.nativeThreadRef?.nativeId) &&
              piTurnEntryId(turn) !== undefined,
          )
          .sort((a, b) => b.ordinal - a.ordinal)[0],
      ) ??
      null;
    const walk =
      listing !== null && (anchorId === null || listing.entries.has(anchorId))
        ? walkPiBranch(listing.entries, listing.leafId, anchorId)
        : null;
    if (listing === null || walk?.reachedStop !== true)
      return yield* protocolError("Pi rollback could not verify the retained session head");
    // A handoff can leave a prompt before the next recorded turn in this file.
    for (const id of [...walk.userEntryIds].reverse()) {
      if (boundary.type === "entry" && id === boundary.entryId) {
        forkEntryId = id;
        break;
      }
      const timestamp = listing.entries.get(id)?.timestamp;
      if (timestamp == null || target?.completedAt == null)
        return yield* protocolError("Pi rollback could not verify the retained session head");
      if (timestamp >= DateTime.toEpochMillis(target.completedAt)) {
        forkEntryId = id;
        break;
      }
    }
  }
  if (forkEntryId === undefined && boundary.type !== "nothing") {
    forkEntryId = yield* piForkEntry(
      driver,
      boundary,
      rollbackInput.providerThread.createdAt,
      sourceEntries,
    );
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
  if (recoveredLegacySource !== undefined) {
    const listing = piSessionListing(entriesData);
    if (
      listing === null ||
      !piSameHistory(
        listing,
        leafId,
        recoveredLegacySource.listing,
        recoveredLegacySource.retained.headId,
      )
    ) {
      invalidateThreadState();
      return yield* protocolError("Pi rollback could not verify the retained session head");
    }
  }
  return { changed: true, forkSessionFile, entriesData, leafId };
});
