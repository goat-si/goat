import { GitCommandError } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { makeGitMetadataFingerprint } from "../vcs/gitMetadataFingerprint.ts";

const FRESH_READ_TTL_MS = 1_000;
const BACKGROUND_READ_TTL_MS = 5 * 60_000;

export const makePrLookupGitState = Effect.fn("PrLookupGitState.make")(function* (options: {
  readonly normalizeCwd: (cwd: string) => Effect.Effect<string>;
  readonly capacity: number;
}) {
  const fingerprint = yield* makeGitMetadataFingerprint();
  const epochs = new Map<string, number>();
  const fingerprints = new Map<string, string>();
  const remembered = new Map<
    string,
    { readonly startedAtMs: number; readonly completedAtMs: number; readonly value: string | null }
  >();
  const pending = new Map<string, Effect.Effect<string | null, GitCommandError>>();
  const epoch = (cwd: string) => epochs.get(cwd) ?? 0;
  const clear = (cwd: string) => {
    const prefix = `${cwd}\u0000`;
    for (const key of remembered.keys()) {
      if (key.startsWith(prefix)) remembered.delete(key);
    }
  };
  const saveFingerprint = (key: string, value: string) => {
    fingerprints.delete(key);
    if (fingerprints.size >= options.capacity) {
      const oldest = fingerprints.keys().next().value;
      if (oldest !== undefined) fingerprints.delete(oldest);
    }
    fingerprints.set(key, value);
  };
  const bumpEpoch = Effect.fn("PrLookupGitState.bumpEpoch")(function* (cwd: string) {
    const key = yield* options.normalizeCwd(cwd);
    epochs.set(key, epoch(key) + 1);
  });
  const forget = Effect.fn("PrLookupGitState.forget")(function* (cwd: string) {
    clear(yield* options.normalizeCwd(cwd));
  });
  const validate = Effect.fn("PrLookupGitState.validate")(function* (
    cwd: string,
    branch: string,
    refresh: boolean,
  ) {
    const metadata = yield* fingerprint(cwd, branch);
    if (metadata === null) {
      epochs.set(cwd, epoch(cwd) + 1);
      clear(cwd);
      return;
    }
    const branchKey = `${cwd}\u0000${branch}`;
    const previousRepository = fingerprints.get(cwd);
    const previousRefs = fingerprints.get(branchKey);
    // Shared remote/config reads must also invalidate when this is the first lookup
    // for a branch after another branch populated the repository cache.
    if (
      (previousRepository !== undefined && previousRepository !== metadata.repository) ||
      (previousRefs !== undefined && previousRefs !== metadata.refs)
    ) {
      epochs.set(cwd, epoch(cwd) + 1);
      clear(cwd);
    }
    if (refresh) clear(cwd);
    saveFingerprint(cwd, metadata.repository);
    saveFingerprint(branchKey, metadata.refs);
  });
  const remember = Effect.fn("GitManager.rememberPrLookupGitState")(function* (
    cwd: string,
    key: string,
    fresh: boolean,
    read: Effect.Effect<string | null, GitCommandError>,
  ) {
    const entryKey = `${cwd}\u0000${key}`;
    const startedAtMs = yield* Clock.currentTimeMillis;
    const entry = remembered.get(entryKey);
    // A validated fresh lookup may share a short burst; background reads keep
    // their existing TTL. Explicit refresh and GOAT mutations clear both.
    if (
      entry !== undefined &&
      startedAtMs - entry.completedAtMs < (fresh ? FRESH_READ_TTL_MS : BACKGROUND_READ_TTL_MS)
    ) {
      return entry.value;
    }
    const generation = epoch(cwd);
    const pendingKey = `${entryKey}\u0000${generation}`;
    let shared = pending.get(pendingKey);
    if (shared === undefined) {
      shared = yield* Effect.cached(
        read.pipe(Effect.ensuring(Effect.sync(() => pending.delete(pendingKey)))),
      );
      pending.set(pendingKey, shared);
    }
    const value = yield* shared;
    const completedAtMs = yield* Clock.currentTimeMillis;
    const latest = remembered.get(entryKey);
    // A git mutation must not let an older in-flight read repopulate its cache.
    if (epoch(cwd) !== generation || (latest !== undefined && latest.startedAtMs > startedAtMs))
      return value;
    remembered.delete(entryKey);
    if (remembered.size >= options.capacity) {
      const oldest = remembered.keys().next().value;
      if (oldest !== undefined) remembered.delete(oldest);
    }
    remembered.set(entryKey, { startedAtMs, completedAtMs, value });
    return value;
  });
  return { epoch, bumpEpoch, remember, forget, validate };
});
