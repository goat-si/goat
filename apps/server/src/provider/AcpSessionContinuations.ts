import type { AcpRegistrySession } from "@goat/contracts";
import type { AcpRegistrySessionPage } from "@goat/provider-core/server/driver";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const TTL_MS = 10 * 60 * 1000;
const RESPONSE_ROWS = 256;
const MAX_HELD_ROWS = 1_024;
const MAX_ENTRY_BYTES = 1_048_576;
const MAX_INSTANCE_ENTRIES = 8;
const MAX_ENTRIES = 32;
const MAX_TOTAL_BYTES = 8 * 1_048_576;
const MAX_NEXT_CURSOR = 2_048;
const MAX_PENDING = 64;

export const acpContinuationKey = (instanceId: string, projectId: string) =>
  `${instanceId}\n${projectId}`;

export interface ContinuationPage {
  readonly sessions: ReadonlyArray<AcpRegistrySession>;
  readonly nextCursor: string | null;
  readonly continuation?: string;
  readonly truncated: boolean;
  readonly canLoad: boolean;
  readonly canResume: boolean;
  readonly canDelete: boolean;
}

type ContinuationBegin =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Ready"; readonly page: ContinuationPage }
  | { readonly _tag: "Fetch"; readonly cursor: string; readonly generation: number };

interface Flags {
  readonly droppedSessions: boolean;
  readonly directoriesCut: boolean;
  readonly overflow: boolean;
  readonly cursorDropped: boolean;
}

interface Hold extends Flags {
  readonly generation: number;
  readonly token: string;
  readonly rows: ReadonlyArray<AcpRegistrySession>;
  readonly rawCursor: string | null;
  readonly canLoad: boolean;
  readonly canResume: boolean;
  readonly canDelete: boolean;
  readonly expiresAt: number;
  readonly lastUsed: number;
  readonly bytes: number;
}

const sessionBytes = (session: AcpRegistrySession) =>
  session.sessionId.length +
  session.cwd.length +
  (session.title?.length ?? 0) +
  (session.updatedAt?.length ?? 0) +
  session.additionalDirectories.reduce((sum, directory) => sum + directory.length, 0);

const payloadBytes = (rows: ReadonlyArray<AcpRegistrySession>, rawCursor: string | null) =>
  rows.reduce((sum, session) => sum + sessionBytes(session), 0) + (rawCursor?.length ?? 0);

const isTruncated = (flags: Flags) =>
  flags.droppedSessions || flags.directoriesCut || flags.overflow || flags.cursorDropped;

const instanceOf = (key: string) => key.slice(0, key.indexOf("\n"));

const pageOf = (
  sessions: ReadonlyArray<AcpRegistrySession>,
  hold: Pick<Hold, "canLoad" | "canResume" | "canDelete"> & Flags,
  nextCursor: string | null,
  continuation?: string,
): ContinuationPage => ({
  sessions,
  nextCursor,
  ...(continuation === undefined ? {} : { continuation }),
  truncated: isTruncated(hold),
  canLoad: hold.canLoad,
  canResume: hold.canResume,
  canDelete: hold.canDelete,
});

const trimHeld = (rows: ReadonlyArray<AcpRegistrySession>) => {
  const kept: AcpRegistrySession[] = [];
  let bytes = 0;
  let cut = rows.length > MAX_HELD_ROWS;
  for (const row of rows) {
    const size = sessionBytes(row);
    if (kept.length === MAX_HELD_ROWS || bytes + size > MAX_ENTRY_BYTES) {
      cut = true;
      break;
    }
    kept.push(row);
    bytes += size;
  }
  return { rows: kept, cut };
};

export const makeAcpSessionContinuations = Effect.fn("AcpSessionContinuations.make")(function* () {
  const crypto = yield* Crypto.Crypto;
  const gate = yield* Semaphore.make(1);
  const holds = new Map<string, Hold>();
  // In-flight provider calls, newest claim per key; a commit lands only for the claim still listed.
  const pending = new Map<string, number>();
  let nextGeneration = 0;

  const claimKey = (key: string) => {
    nextGeneration += 1;
    holds.delete(key);
    pending.delete(key);
    pending.set(key, nextGeneration);
    for (const oldest of pending.keys()) {
      if (pending.size <= MAX_PENDING) break;
      pending.delete(oldest);
    }
    return nextGeneration;
  };

  const mint = Effect.fn("AcpSessionContinuations.token")(function* () {
    return (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "");
  });

  const evictExpired = (now: number) => {
    for (const [key, hold] of holds) {
      if (hold.expiresAt <= now) holds.delete(key);
    }
  };

  const withinCaps = (key: string, entry: Hold) => {
    let count = 1;
    let bytes = entry.bytes;
    let instanceCount = 1;
    const instanceId = instanceOf(key);
    for (const [candidate, hold] of holds) {
      if (candidate === key) continue;
      count += 1;
      bytes += hold.bytes;
      if (instanceOf(candidate) === instanceId) instanceCount += 1;
    }
    return (
      count <= MAX_ENTRIES && bytes <= MAX_TOTAL_BYTES && instanceCount <= MAX_INSTANCE_ENTRIES
    );
  };

  const leastRecentlyUsed = (key: string) => {
    let oldestKey: string | undefined;
    let oldestUsed = Number.POSITIVE_INFINITY;
    for (const [candidate, hold] of holds) {
      if (candidate === key) continue;
      if (hold.lastUsed < oldestUsed) {
        oldestUsed = hold.lastUsed;
        oldestKey = candidate;
      }
    }
    return oldestKey;
  };

  const insert = (key: string, entry: Hold, now: number) => {
    evictExpired(now);
    holds.delete(key);
    while (!withinCaps(key, entry)) {
      const victim = leastRecentlyUsed(key);
      if (victim === undefined) return false;
      holds.delete(victim);
    }
    holds.set(key, entry);
    return true;
  };

  const unsaved = (page: AcpRegistrySessionPage): ContinuationPage => {
    const rawCursor = page.cursorDropped ? null : page.rawCursor;
    const droppedRemainder =
      page.sessions.length > RESPONSE_ROWS ||
      page.cursorDropped ||
      (rawCursor !== null && rawCursor.length > MAX_NEXT_CURSOR);
    return pageOf(
      page.sessions.slice(0, RESPONSE_ROWS),
      {
        ...page,
        overflow: page.overflow || droppedRemainder,
      },
      // The provider cursor points past the whole page, so it is only safe when nothing was sliced.
      !droppedRemainder && rawCursor !== null ? rawCursor : null,
    );
  };

  const claim = Effect.fn("AcpSessionContinuations.claim")(function* (key: string) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        evictExpired(yield* Clock.currentTimeMillis);
        return claimKey(key);
      }),
    );
  });

  const abort = Effect.fn("AcpSessionContinuations.abort")(function* (
    key: string,
    generation: number,
  ) {
    yield* gate.withPermit(
      Effect.sync(() => {
        if (pending.get(key) === generation) pending.delete(key);
      }),
    );
  });

  const commit = Effect.fn("AcpSessionContinuations.commit")(function* (
    key: string,
    generation: number,
    page: AcpRegistrySessionPage,
  ) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (pending.get(key) !== generation) return unsaved(page);
        pending.delete(key);
        const rawCursor = page.cursorDropped ? null : page.rawCursor;
        const trimmed = trimHeld(page.sessions.slice(RESPONSE_ROWS));
        const flags: Flags = {
          droppedSessions: page.droppedSessions,
          directoriesCut: page.directoriesCut,
          overflow: page.overflow || trimmed.cut,
          cursorDropped: page.cursorDropped,
        };
        const needsHold =
          trimmed.rows.length > 0 || (rawCursor !== null && rawCursor.length > MAX_NEXT_CURSOR);
        if (!needsHold) {
          holds.delete(key);
          return pageOf(
            page.sessions.slice(0, RESPONSE_ROWS),
            { ...page, ...flags },
            rawCursor !== null && rawCursor.length <= MAX_NEXT_CURSOR ? rawCursor : null,
          );
        }
        const token = yield* mint();
        const entry: Hold = {
          generation,
          token,
          rows: trimmed.rows,
          rawCursor,
          ...flags,
          canLoad: page.canLoad,
          canResume: page.canResume,
          canDelete: page.canDelete,
          expiresAt: now + TTL_MS,
          lastUsed: now,
          bytes: payloadBytes(trimmed.rows, rawCursor),
        };
        if (!insert(key, entry, now)) {
          return pageOf(
            page.sessions.slice(0, RESPONSE_ROWS),
            {
              ...flags,
              canLoad: page.canLoad,
              canResume: page.canResume,
              canDelete: page.canDelete,
              overflow: true,
            },
            null,
          );
        }
        return pageOf(page.sessions.slice(0, RESPONSE_ROWS), entry, null, token);
      }),
    );
  });

  const begin = Effect.fn("AcpSessionContinuations.begin")(function* (key: string, token: string) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        evictExpired(now);
        const entry = holds.get(key);
        if (entry === undefined || entry.token !== token) {
          return { _tag: "Unavailable" } satisfies ContinuationBegin;
        }
        if (entry.rows.length === 0 && entry.rawCursor === null) {
          holds.delete(key);
          return { _tag: "Ready", page: pageOf([], entry, null) } satisfies ContinuationBegin;
        }
        if (entry.rows.length === 0 && entry.rawCursor !== null) {
          const cursor = entry.rawCursor;
          return { _tag: "Fetch", cursor, generation: claimKey(key) } satisfies ContinuationBegin;
        }
        const taken = entry.rows.slice(0, RESPONSE_ROWS);
        const rest = entry.rows.slice(RESPONSE_ROWS);
        const longCursor = entry.rawCursor !== null && entry.rawCursor.length > MAX_NEXT_CURSOR;
        if (rest.length > 0 || longCursor) {
          const nextToken = yield* mint();
          holds.set(key, {
            ...entry,
            token: nextToken,
            rows: rest,
            bytes: payloadBytes(rest, entry.rawCursor),
            lastUsed: now,
            expiresAt: now + TTL_MS,
          });
          return {
            _tag: "Ready",
            page: pageOf(taken, entry, null, nextToken),
          } satisfies ContinuationBegin;
        }
        holds.delete(key);
        return {
          _tag: "Ready",
          page: pageOf(
            taken,
            entry,
            entry.rawCursor !== null && entry.rawCursor.length <= MAX_NEXT_CURSOR
              ? entry.rawCursor
              : null,
          ),
        } satisfies ContinuationBegin;
      }),
    );
  });

  const scrub = Effect.fn("AcpSessionContinuations.scrub")(function* (
    key: string,
    sessionId: string,
  ) {
    yield* gate.withPermit(
      Effect.sync(() => {
        const entry = holds.get(key);
        if (entry === undefined) return;
        const rows = entry.rows.filter((session) => session.sessionId !== sessionId);
        if (rows.length === entry.rows.length) return;
        holds.set(key, { ...entry, rows, bytes: payloadBytes(rows, entry.rawCursor) });
      }),
    );
  });

  return { claim, abort, commit, begin, scrub };
});
