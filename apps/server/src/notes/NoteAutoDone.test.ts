import * as Context from "effect/Context";
import { assert, it } from "@effect/vitest";
import {
  NoteError,
  RunId,
  ThreadId,
  type ThreadResult,
  type OrchestrationV2StoredEvent,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Hosts from "../mcp/HostThreadsMcpService.ts";
import * as Notes from "./NotesService.ts";
import * as Auto from "./NoteAutoDone.ts";
import { notesLayer } from "./NotesTestkit.ts";

const link = { threadId: ThreadId.make("worker"), host: null, lastResult: null };
const succeeded: ThreadResult = {
  runId: RunId.make("run"),
  runStatus: "completed",
  outcome: "succeeded",
  reportedAt: null,
  pullRequests: [],
  commits: [],
  branch: null,
};
const autoLayer = (events: Stream.Stream<OrchestrationV2StoredEvent> = Stream.never) =>
  Auto.layer.pipe(
    Layer.provide(Layer.mock(Hosts.HostThreadsMcpService)({})),
    Layer.provide(Layer.mock(EventSink.EventSinkV2)({ latestSequence: () => Effect.succeed(42) })),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamStoredEventsFrom: (input) => {
          assert.strictEqual(input?.afterSequence, 42);
          assert.strictEqual(input?.eventType, "run.updated");
          return events;
        },
      }),
    ),
  );

it.effect("startup reconciliation settles completion before link and after restart", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
    yield* notes.link("task.md", link);
    yield* Layer.build(autoLayer());
    const note = yield* notes.read({ path: "task.md" });
    assert.strictEqual(note.status, "done");
    assert.strictEqual(note.updatedBy, "agent");
  }).pipe(Effect.provide(notesLayer(() => Effect.succeed(succeeded)))),
);

it.effect("a run event after an early report marks the last linked thread done", () => {
  let result: ThreadResult = { ...succeeded, runStatus: "running" };
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const observerReady = yield* Deferred.make<void>();
    const live = Stream.unwrap(
      PubSub.subscribe(events).pipe(
        Effect.tap(() => Deferred.succeed(observerReady, undefined)),
        Effect.map(Stream.fromSubscription),
      ),
    );
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
    yield* notes.link("task.md", link);
    yield* Layer.build(autoLayer(live));
    yield* Deferred.await(observerReady);
    assert.strictEqual((yield* notes.read({ path: "task.md" })).status, "doing");
    const ready = yield* Deferred.make<void>();
    const completed = yield* notes.subscribe.pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.filter((event) => event.type === "upserted" && event.note.status === "done"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    result = succeeded;
    yield* PubSub.publish(events, {
      sequence: 43,
      commandId: null,
      event: { type: "run.updated", threadId: link.threadId },
    } as OrchestrationV2StoredEvent);
    yield* Fiber.join(completed);
    assert.strictEqual((yield* notes.read({ path: "task.md" })).status, "done");
  }).pipe(Effect.provide(notesLayer(() => Effect.sync(() => result))));
});

it.effect("linking a completed worker reconciles immediately via the notes stream", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
    yield* Layer.build(autoLayer());
    const ready = yield* Deferred.make<void>();
    const completed = yield* notes.subscribe.pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.filter((event) => event.type === "upserted" && event.note.status === "done"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    yield* notes.link("task.md", link);
    yield* Fiber.join(completed);
  }).pipe(Effect.provide(notesLayer(() => Effect.succeed(succeeded)))),
);

it.effect("older thread success and a missing latest report remain doing", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
    yield* notes.link("task.md", link);
    const last = { ...link, threadId: ThreadId.make("last") };
    yield* notes.link("task.md", last);
    const auto = Context.get(yield* Layer.build(autoLayer()), Auto.NoteAutoDone);
    yield* auto.reconcile;
    assert.strictEqual((yield* notes.read({ path: "task.md" })).status, "doing");
  }).pipe(
    Effect.provide(
      notesLayer((entry) =>
        Effect.succeed(
          entry.threadId === link.threadId ? succeeded : { ...succeeded, outcome: null },
        ),
      ),
    ),
  ),
);

it.effect(
  "remote follower uses only its own host/thread and waits for a successful completed result",
  () => {
    let result: ThreadResult | null = null;
    return Effect.gen(function* () {
      const waitStarted = yield* Deferred.make<void>();
      const remoteFinished = yield* Deferred.make<void>();
      const notes = yield* Notes.NotesService;
      const remote = { ...link, host: "host-a" };
      yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
      yield* notes.link("task.md", remote);
      const hosts = Layer.mock(Hosts.HostThreadsMcpService)({
        waitForThread: (scope, input) =>
          Effect.gen(function* () {
            assert.strictEqual(scope.thread, undefined);
            assert.strictEqual(scope.client?.access, "full-access");
            assert.strictEqual(input.host, "host-a");
            assert.strictEqual(input.threadId, link.threadId);
            yield* Deferred.succeed(waitStarted, undefined);
            yield* Deferred.await(remoteFinished);
            return {
              host: "host-a",
              threadId: link.threadId,
              runId: succeeded.runId,
              status: "completed" as const,
              timedOut: false,
              result: succeeded,
            };
          }),
      });
      yield* Layer.build(
        Auto.layer.pipe(
          Layer.provide(hosts),
          Layer.provide(
            Layer.mock(EventSink.EventSinkV2)({ latestSequence: () => Effect.succeed(0) }),
          ),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({ streamStoredEventsFrom: () => Stream.never }),
          ),
        ),
      );
      yield* Deferred.await(waitStarted);
      const ready = yield* Deferred.make<void>();
      const completed = yield* notes.subscribe.pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.filter((event) => event.type === "upserted" && event.note.status === "done"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      result = succeeded;
      yield* Deferred.succeed(remoteFinished, undefined);
      yield* Fiber.join(completed);
    }).pipe(Effect.provide(notesLayer(() => Effect.sync(() => result))));
  },
);

it.effect("a late result report settles an already completed local run", () => {
  let result: ThreadResult = { ...succeeded, outcome: null };
  return Effect.gen(function* () {
    const reports = yield* PubSub.unbounded<typeof link>();
    const reportStream = Stream.unwrap(
      PubSub.subscribe(reports).pipe(Effect.map(Stream.fromSubscription)),
    );
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
      yield* notes.link("task.md", link);
      yield* Layer.build(autoLayer());
      assert.strictEqual((yield* notes.read({ path: "task.md" })).status, "doing");
      const ready = yield* Deferred.make<void>();
      const completed = yield* notes.subscribe.pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.filter((event) => event.type === "upserted" && event.note.status === "done"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      result = succeeded;
      yield* PubSub.publish(reports, link);
      yield* Fiber.join(completed);
    }).pipe(Effect.provide(notesLayer(() => Effect.sync(() => result), reportStream)));
  });
});

it.effect("unrelated run updates do no global scans or result lookups", () => {
  let lookups = 0;
  let scans = 0;
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
    yield* notes.link("task.md", link);
    const trigger = yield* Deferred.make<void>();
    const processed = yield* Deferred.make<void>();
    const events = Stream.concat(
      Stream.drain(Stream.fromEffect(Deferred.await(trigger))),
      Stream.concat(
        Stream.make(
          ...Array.from(
            { length: 20 },
            (_, index) =>
              ({
                sequence: 43 + index,
                commandId: null,
                event: {
                  type: "run.updated",
                  threadId: ThreadId.make("unrelated"),
                  payload: { status: "running" },
                },
              }) as OrchestrationV2StoredEvent,
          ),
        ),
        Stream.drain(Stream.fromEffect(Deferred.succeed(processed, undefined))),
      ),
    );
    yield* Layer.build(
      autoLayer(events).pipe(
        Layer.provide(
          Layer.succeed(Notes.NotesService, {
            ...notes,
            all: Effect.suspend(() => {
              scans++;
              return notes.all;
            }),
          }),
        ),
      ),
    );
    lookups = 0;
    scans = 0;
    yield* Deferred.succeed(trigger, undefined);
    yield* Deferred.await(processed);
    assert.strictEqual(scans, 0);
    assert.strictEqual(lookups, 0);
  }).pipe(
    Effect.provide(
      notesLayer(() =>
        Effect.sync(() => {
          lookups++;
          return { ...succeeded, runStatus: "running" };
        }),
      ),
    ),
  );
});

it.effect("remote followers share a thread wait, cap concurrency and release slots on unlink", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fourStarted = yield* Deferred.make<void>();
    const fifthStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const calls: Array<string> = [];
    let active = 0;
    let maximum = 0;
    for (let index = 0; index < 5; index++) {
      const path = `task-${index}.md`;
      yield* notes.write({ path, body: "work", baseRevision: null }, "user");
      yield* notes.link(path, {
        ...link,
        host: "host-a",
        threadId: ThreadId.make(`worker-${index}`),
      });
    }
    yield* notes.write({ path: "duplicate.md", body: "same worker", baseRevision: null }, "user");
    yield* notes.link("duplicate.md", {
      ...link,
      host: "host-a",
      threadId: ThreadId.make("worker-0"),
    });
    yield* Layer.build(
      Auto.layer.pipe(
        Layer.provide(
          Layer.mock(Hosts.HostThreadsMcpService)({
            waitForThread: (_scope, input) =>
              Effect.gen(function* () {
                calls.push(input.threadId);
                yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    active++;
                    maximum = Math.max(maximum, active);
                  }),
                  () =>
                    Effect.sync(() => {
                      active--;
                    }),
                );
                if (calls.length === 4) yield* Deferred.succeed(fourStarted, undefined);
                if (calls.length === 5) yield* Deferred.succeed(fifthStarted, undefined);
                yield* Deferred.await(release);
                return {
                  host: "host-a",
                  threadId: input.threadId,
                  runId: null,
                  status: null,
                  timedOut: true,
                  result: null,
                } as never;
              }).pipe(Effect.scoped),
          }),
        ),
        Layer.provide(
          Layer.mock(EventSink.EventSinkV2)({ latestSequence: () => Effect.succeed(0) }),
        ),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({ streamStoredEventsFrom: () => Stream.never }),
        ),
      ),
    );
    yield* Deferred.await(fourStarted);
    assert.strictEqual(active, 4);
    for (const path of ["task-0.md", "duplicate.md"]) {
      const note = yield* notes.read({ path });
      yield* notes.write(
        { path, body: note.body, status: "idea", baseRevision: note.revision },
        "user",
      );
    }
    yield* Deferred.await(fifthStarted);
    assert.strictEqual(maximum, 4);
    assert.strictEqual(calls.filter((thread) => thread === "worker-0").length, 1);
  }).pipe(Effect.provide(notesLayer())),
);

it.effect(
  "a storage failure does not stop later note events and the failed note retries on an edit",
  () =>
    Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const failed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let fail = true;
      for (const path of ["first.md", "second.md"]) {
        yield* notes.write({ path, body: "work", baseRevision: null }, "user");
      }
      yield* Layer.build(
        autoLayer().pipe(
          Layer.provide(
            Layer.succeed(Notes.NotesService, {
              ...notes,
              complete: (path, entry, observed) =>
                Effect.gen(function* () {
                  if (path === "first.md" && fail) {
                    yield* Deferred.succeed(failed, undefined);
                    yield* Deferred.await(release);
                    return yield* new NoteError({
                      reason: "storage",
                      message: "Storage unavailable.",
                    });
                  }
                  return yield* notes.complete(path, entry, observed);
                }),
            }),
          ),
        ),
      );
      const changes = yield* notes.subscribeChanges;
      const secondDone = yield* changes.pipe(
        Stream.filter(
          (event) =>
            event.type === "upserted" &&
            event.note.path === "second.md" &&
            event.note.status === "done",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* notes.link("first.md", link);
      yield* Deferred.await(failed);
      yield* notes.link("second.md", { ...link, threadId: ThreadId.make("second-worker") });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(secondDone);
      fail = false;
      const recovered = yield* changes.pipe(
        Stream.filter(
          (event) =>
            event.type === "upserted" &&
            event.note.path === "first.md" &&
            event.note.status === "done",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const first = (yield* notes.cached("first.md"))!;
      yield* notes.write({ path: "first.md", body: "retry", baseRevision: first.revision }, "user");
      yield* Fiber.join(recovered);
      assert.strictEqual((yield* notes.cached("first.md"))?.status, "done");
    }).pipe(Effect.provide(notesLayer(() => Effect.succeed(succeeded)))),
);

it.effect("a structured remote wait completes the note even when follow-up reads return null", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const waitStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const settled = yield* Deferred.make<void>();
    const remote = { ...link, host: "slow-host" };
    let waited = false;
    let followUpReads = 0;
    yield* notes.write({ path: "task.md", body: "work", baseRevision: null }, "user");
    yield* notes.link("task.md", remote);
    yield* Layer.build(
      Auto.layer.pipe(
        Layer.provide(
          Layer.mock(Hosts.HostThreadsMcpService)({
            waitForThread: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(waitStarted, undefined);
                yield* Deferred.await(release);
                waited = true;
                return {
                  host: remote.host,
                  threadId: remote.threadId,
                  runId: succeeded.runId,
                  status: "completed" as const,
                  timedOut: false,
                  result: succeeded,
                };
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(EventSink.EventSinkV2)({ latestSequence: () => Effect.succeed(0) }),
        ),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({ streamStoredEventsFrom: () => Stream.never }),
        ),
        Layer.provide(
          Layer.succeed(Notes.NotesService, {
            ...notes,
            refreshResults: (...args) => {
              if (waited && args[2] === undefined) followUpReads++;
              return notes.refreshResults(...args);
            },
            complete: (...args) =>
              notes
                .complete(...args)
                .pipe(
                  Effect.onExit(() =>
                    waited ? Deferred.succeed(settled, undefined) : Effect.void,
                  ),
                ),
          }),
        ),
      ),
    );
    yield* Deferred.await(waitStarted);
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(settled);
    assert.strictEqual((yield* notes.cached("task.md"))?.status, "done");
    assert.strictEqual(followUpReads, 0);
  }).pipe(Effect.provide(notesLayer())),
);

it.effect("a doing note associated only through related never completes", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const reference = { threadId: link.threadId, host: "host-a" };
    yield* notes.write(
      { path: "reference.md", body: "work", status: "doing", baseRevision: null },
      "user",
    );
    yield* notes.update({ path: "reference.md", relate: reference });
    const auto = Context.get(yield* Layer.build(autoLayer()), Auto.NoteAutoDone);
    yield* auto.reconcile;
    yield* notes.refreshResults(reference.threadId, reference.host, succeeded);
    yield* auto.reconcileNote("reference.md");
    const note = yield* notes.read({ path: "reference.md" });
    assert.strictEqual(note.status, "doing");
    assert.strictEqual(note.updatedBy, "user");
    assert.deepStrictEqual(note.related, [reference]);
    assert.deepStrictEqual(note.threads, []);
    assert.deepStrictEqual(yield* notes.linked(reference.threadId, reference.host), []);
  }).pipe(Effect.provide(notesLayer(() => Effect.succeed(succeeded)))),
);
