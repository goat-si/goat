import {
  type NoteError,
  type NotePath,
  type NoteThreadLink,
  type NoteSummary,
  type ThreadResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Hosts from "../mcp/HostThreadsMcpService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Notes from "./NotesService.ts";
import * as Results from "./NoteResults.ts";

export class NoteAutoDone extends Context.Service<
  NoteAutoDone,
  {
    readonly reconcile: Effect.Effect<void, NoteError>;
    readonly reconcileNote: (path: NotePath) => Effect.Effect<void, NoteError>;
  }
>()("goat/notes/NoteAutoDone") {}

const make = Effect.gen(function* () {
  const notes = yield* Notes.NotesService;
  const results = yield* Results.NoteResults;
  const hosts = yield* Hosts.HostThreadsMcpService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const scope = yield* Effect.scope;
  const remoteSlots = yield* Semaphore.make(4);
  const followerLock = yield* Semaphore.make(1);
  const followers = new Map<string, { link: NoteThreadLink; fiber: Fiber.Fiber<void, never> }>();
  const key = (link: NoteThreadLink) => JSON.stringify([link.host, link.threadId]);
  const isLast = (note: NoteSummary, link: NoteThreadLink) => {
    const last = note.threads.at(-1);
    return note.status === "doing" && last?.threadId === link.threadId && last.host === link.host;
  };
  const settle = (link: NoteThreadLink) =>
    Effect.gen(function* () {
      const linked = yield* notes.linked(link.threadId, link.host);
      yield* Effect.forEach(
        linked.filter((note) => isLast(note, link)),
        (note) => notes.complete(note.path, link, note.threads.at(-1)!.lastResult),
        { concurrency: 4 },
      );
    });
  const refresh = (link: NoteThreadLink, observed?: ThreadResult) =>
    notes.refreshResults(link.threadId, link.host, observed).pipe(Effect.andThen(settle(link)));
  const follow = (link: NoteThreadLink) =>
    Effect.gen(function* () {
      if (link.host === null) return;
      while ((yield* notes.linked(link.threadId, link.host)).some((note) => isLast(note, link))) {
        const waited = yield* remoteSlots.withPermits(1)(
          hosts
            .waitForThread(results.scope, {
              host: link.host,
              threadId: link.threadId,
              timeoutMs: 60_000,
            })
            .pipe(
              Effect.timeoutOption("65 seconds"),
              Effect.orElseSucceed(() => null),
            ),
        );
        const response = waited?._tag === "Some" ? waited.value : null;
        if (response?.result) yield* results.remember(link, response.result);
        yield* refresh(link, response?.result ?? undefined).pipe(Effect.ignore({ log: true }));
        // Legacy hosts and failures can return immediately. Clock-backed backoff avoids a busy loop.
        if (!response?.timedOut) yield* Effect.sleep("5 seconds");
      }
    });
  const syncFollower = (link: NoteThreadLink) =>
    followerLock.withPermits(1)(
      Effect.gen(function* () {
        if (link.host === null) return;
        const id = key(link);
        const wanted = (yield* notes.linked(link.threadId, link.host)).some((note) =>
          isLast(note, link),
        );
        const current = followers.get(id);
        if (!wanted && current) {
          followers.delete(id);
          yield* Fiber.interrupt(current.fiber);
        } else if (wanted && !current) {
          const fiber = yield* follow(link).pipe(Effect.forkIn(scope));
          followers.set(id, { link, fiber });
        }
      }),
    );
  const reconcileCached = (path: NotePath) =>
    Effect.gen(function* () {
      const note = yield* notes.cached(path);
      const last = note?.threads.at(-1);
      if (note?.status === "doing" && last) {
        yield* notes.complete(path, last, last.lastResult);
        yield* syncFollower(last);
      }
    });
  const reconcileNote = (path: NotePath) =>
    Effect.gen(function* () {
      const note = yield* notes.cached(path);
      const last = note?.threads.at(-1);
      if (note?.status === "doing" && last) yield* refresh(last);
      yield* reconcileCached(path);
    });
  const reconcile = Effect.gen(function* () {
    // Recovery alone rescans disk; ordinary run/result/note events use the shared read model.
    yield* notes.refresh;
    const snapshot = yield* notes.all;
    const links = new Map<string, NoteThreadLink>();
    for (const note of snapshot) for (const link of note.threads) links.set(key(link), link);
    yield* Effect.forEach(links.values(), (link) => refresh(link), { concurrency: 4 });
    yield* Effect.forEach(snapshot, (note) => reconcileCached(note.path), { concurrency: 4 });
    yield* Effect.forEach([...followers.values()], ({ link }) => syncFollower(link), {
      concurrency: 4,
    });
  });
  const sequence = yield* sink.latestSequence().pipe(Effect.orDie);
  yield* orchestrator
    .streamStoredEventsFrom({ afterSequence: sequence, eventType: "run.updated" })
    .pipe(
      Stream.runForEach((stored) =>
        stored.event.threadId === null
          ? Effect.void
          : refresh({ threadId: stored.event.threadId, host: null, lastResult: null }).pipe(
              Effect.ignore({ log: true }),
            ),
      ),
      Effect.ignore({ log: true }),
      Effect.forkScoped,
    );
  const reports = yield* results.subscribeChanges;
  yield* reports.pipe(
    Stream.runForEach((link) => refresh(link).pipe(Effect.ignore({ log: true }))),
    Effect.forkScoped,
  );
  const noteChanges = yield* notes.subscribeChanges;
  const previous = new Map<NotePath, NoteSummary>();
  const retry = new Set<NotePath>();
  for (const note of yield* notes.all) previous.set(note.path, note);
  const changed = (note: NoteSummary) =>
    Effect.gen(function* () {
      const old = previous.get(note.path);
      previous.set(note.path, note);
      const last = note.threads.at(-1);
      const oldLast = old?.threads.at(-1);
      const unchanged =
        old?.status === note.status &&
        oldLast?.threadId === last?.threadId &&
        oldLast?.host === last?.host;
      if (unchanged && !retry.has(note.path)) return;
      if (unchanged) yield* reconcileCached(note.path);
      else {
        if (oldLast) yield* syncFollower(oldLast);
        yield* reconcileNote(note.path);
      }
      retry.delete(note.path);
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          retry.add(note.path);
        }),
      ),
    );
  yield* noteChanges.pipe(
    Stream.runForEach((event) => {
      if (event.type === "snapshot") return Effect.void;
      if (event.type === "upserted") return changed(event.note).pipe(Effect.ignore({ log: true }));
      return Effect.gen(function* () {
        const old = previous.get(event.path);
        previous.delete(event.path);
        retry.delete(event.path);
        const last = old?.threads.at(-1);
        if (last) yield* syncFollower(last);
      }).pipe(Effect.ignore({ log: true }));
    }),
    Effect.ignore({ log: true }),
    Effect.forkScoped,
  );
  yield* reconcile;
  return NoteAutoDone.of({ reconcile, reconcileNote });
});
export const layer = Layer.effect(NoteAutoDone, make);
