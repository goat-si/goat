import { PenId, type AuthClientSession, type AuthSessionId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as AuthSessions from "../persistence/AuthSessions.ts";
import type { SessionCredentialChange } from "./SessionStore.ts";
import {
  InvalidSessionTokenPayloadError,
  SessionCredentialIssueError,
  UnknownSessionTokenError,
} from "./sessionStoreErrors.ts";

const isPenId = Schema.is(PenId);

/** Who may sign in as a Pen member right now: the member node ids, or nobody. */
export type PenAdmission = ReadonlySet<string> | "closed";

type Row = {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly penMemberNode: string | null;
  readonly expiresAt?: DateTime.DateTime | undefined;
};

/** Live member sessions held at once. Past it a new one is refused, never left unfenced. */
const MAX_TRACKED = 4096;

const relevant = (row: Row) => row.penMemberNode !== null || row.subject.startsWith("pen-member:");
const deniedBy = (row: Row, admitted: PenAdmission) =>
  row.penMemberNode === null
    ? row.subject.startsWith("pen-member:")
    : !isPenId(row.penMemberNode) ||
      row.subject !== `pen-member:${row.penMemberNode}` ||
      admitted === "closed" ||
      !admitted.has(row.penMemberNode);

/**
 * The sessions other Pen members hold on this server, admitted only while Pen lists their node.
 * Every check reads the newest admission through `follow`'s reader; `publish` only tells clients
 * which sessions appeared or went since the last publication.
 */
export const make = Effect.fn("PenMemberSessionFence.make")(function* (
  initial: ReadonlyArray<Row>,
  suspend: (id: AuthSessionId) => Effect.Effect<void>,
  resume: (id: AuthSessionId) => Effect.Effect<void>,
  options?: { readonly maxTracked?: number },
) {
  const maxTracked = options?.maxTracked ?? MAX_TRACKED;
  const lock = yield* Semaphore.make(1);
  const rows = new Map(initial.filter(relevant).map((row) => [row.sessionId, row]));
  let read: Effect.Effect<PenAdmission> = Effect.succeed("closed");
  let published: PenAdmission = "closed";
  const prune = Effect.fn("PenMemberSessionFence.prune")(function* () {
    const now = (yield* DateTime.now).epochMilliseconds;
    for (const [id, row] of rows)
      if (row.expiresAt !== undefined && row.expiresAt.epochMilliseconds <= now) rows.delete(id);
  });
  const roomFor = Effect.fn("PenMemberSessionFence.roomFor")(function* (id: AuthSessionId) {
    if (rows.has(id) || rows.size < maxTracked) return true;
    yield* prune();
    return rows.size < maxTracked;
  });
  /** Tracks the row; false when it is a member session there was no room for. */
  const observe = Effect.fn("PenMemberSessionFence.observe")((row: Row) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (!relevant(row)) return void rows.delete(row.sessionId);
        if (!(yield* roomFor(row.sessionId))) return false;
        const expiresAt = row.expiresAt ?? rows.get(row.sessionId)?.expiresAt;
        rows.set(row.sessionId, { ...row, expiresAt });
        if (deniedBy(row, yield* read)) yield* suspend(row.sessionId);
        return true;
      }),
    ),
  );
  const denied = Effect.fn("PenMemberSessionFence.denied")(function* (id: AuthSessionId) {
    const row = rows.get(id);
    return row === undefined ? false : deniedBy(row, yield* read);
  });
  const deniedRow = Effect.fn("PenMemberSessionFence.deniedRow")(function* (row: Row) {
    const tracked = yield* observe(row);
    return tracked === false || (yield* denied(row.sessionId));
  });
  const guardId = Effect.fn("PenMemberSessionFence.guardId")(function* (id: AuthSessionId) {
    if (yield* denied(id)) return yield* new UnknownSessionTokenError({ sessionId: id });
  });
  const guard = Effect.fn("PenMemberSessionFence.guard")(function* (row: Row) {
    if (yield* deniedRow(row))
      return yield* new UnknownSessionTokenError({ sessionId: row.sessionId });
  });
  /** Publishes which sessions the newest admission opened or closed. */
  const publish = lock.withPermit(
    Effect.gen(function* () {
      yield* prune();
      const admitted = yield* read;
      for (const [id, row] of rows) {
        const before = deniedBy(row, published);
        const after = deniedBy(row, admitted);
        if (after && !before) yield* suspend(id);
        if (!after && before) yield* resume(id);
      }
      published = admitted;
    }),
  );
  return {
    observe,
    guard,
    guardId,
    denied,
    deniedRow,
    publish,
    tracked: () => rows.size,
    /** Every later check reads `next` at once; `around` wraps only the publication after it. */
    follow: (
      next: Effect.Effect<PenAdmission>,
      around: (publish: Effect.Effect<void>) => Effect.Effect<void> = (publish) => publish,
    ) =>
      Effect.sync(() => {
        read = next;
      }).pipe(Effect.andThen(around(publish))),
    forget: (id: AuthSessionId) => lock.withPermit(Effect.sync(() => void rows.delete(id))),
    /** The rows a session listing may show. */
    visible: <A extends Row>(listed: ReadonlyArray<A>) =>
      Effect.filter(listed, (row) => Effect.map(deniedRow(row), (no) => !no)),
    /** Tracks a session just issued under `subject`. */
    observeIssued: (
      issued: {
        readonly sessionId: AuthSessionId;
        readonly subject: string;
        readonly expiresAt: DateTime.DateTime;
      },
      input: { readonly penMemberNode?: string } | undefined,
    ) => observe({ ...issued, penMemberNode: input?.penMemberNode ?? null }),
    /** The subject a session is issued under, refusing a malformed or untrackable member one. */
    issueSubject: Effect.fn("PenMemberSessionFence.issueSubject")(function* (
      input: { readonly subject?: string; readonly penMemberNode?: string } | undefined,
      sessionId: AuthSessionId,
    ) {
      const node = input?.penMemberNode;
      if (node === undefined) return input?.subject ?? "browser";
      if (!isPenId(node) || input?.subject !== undefined)
        return yield* new SessionCredentialIssueError({
          sessionId,
          cause: "Invalid Pen member issuance",
        });
      if (!(yield* lock.withPermit(roomFor(sessionId))))
        return yield* new SessionCredentialIssueError({
          sessionId,
          cause: "Too many Pen member sessions",
        });
      return `pen-member:${node}`;
    }),
    /** A member session is admitted by its stored marker, so its signed subject must be the row's. */
    guardSigned: Effect.fn("PenMemberSessionFence.guardSigned")(function* (
      signed: string,
      row: Row,
    ) {
      if (
        signed !== row.subject &&
        (row.penMemberNode !== null ||
          signed.startsWith("pen-member:") ||
          row.subject.startsWith("pen-member:"))
      )
        return yield* new InvalidSessionTokenPayloadError({ cause: "Session subject mismatch" });
      yield* guard(row);
    }),
  };
});

/** The fence over a session store's change feed: a session it denies is never announced. */
export const makeForStore = Effect.fn("PenMemberSessionFence.makeForStore")(function* <E>(
  initial: ReadonlyArray<Row>,
  changes: PubSub.PubSub<SessionCredentialChange>,
  load: (id: AuthSessionId) => Effect.Effect<Option.Option<AuthClientSession>, E>,
) {
  const fence = yield* make(
    initial,
    (sessionId) =>
      PubSub.publish(changes, { type: "clientRemoved", sessionId }).pipe(Effect.asVoid),
    (sessionId): Effect.Effect<void> =>
      load(sessionId).pipe(
        Effect.flatMap((session) =>
          Option.isSome(session) ? emitUpsert(session.value) : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to publish Pen session admission", { cause }),
        ),
      ),
  );
  const emitUpsert = (clientSession: AuthClientSession): Effect.Effect<void> =>
    Effect.flatMap(fence.denied(clientSession.sessionId), (denied) =>
      denied ? Effect.void : PubSub.publish(changes, { type: "clientUpserted", clientSession }),
    ).pipe(Effect.asVoid);
  return { fence, emitUpsert };
});

/** What SessionStore offers the Pen member reconciler. */
export const forStore = (
  fence: Effect.Success<ReturnType<typeof make>>,
  authorityLock: Semaphore.Semaphore,
  repository: AuthSessions.AuthSessionRepository["Service"],
) => ({
  /** Every member-session check reads `read` from now on; publishes what that changed. */
  followPenMembers: (read: Effect.Effect<PenAdmission>) =>
    fence.follow(read, (publish) => authorityLock.withPermit(publish)),
  listPenMemberSessions: listMemberSessions(repository),
});
export type StorePenMembers = ReturnType<typeof forStore>;

/** The unrevoked, unexpired member sessions stored here. */
const listMemberSessions = Effect.fn("PenMemberSessionFence.listMemberSessions")(function* (
  repository: AuthSessions.AuthSessionRepository["Service"],
) {
  const rows = yield* repository.listActive({ now: yield* DateTime.now });
  return rows.flatMap((row) =>
    row.penMemberNode === null
      ? []
      : [{ sessionId: row.sessionId, penMemberNode: row.penMemberNode }],
  );
}, Effect.orDie);
