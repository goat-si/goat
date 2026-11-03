import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";
import { makeTestBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";
import { makeBrowserOriginGrants } from "./BrowserOriginGrants.ts";

class NarrowWriteFailure extends Schema.TaggedError<NarrowWriteFailure>()(
  "NarrowWriteFailure",
  {},
) {}

it.effect("a newer narrower manifest supersedes a failed confirmation without restarting", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const firstFinished = yield* Deferred.make<void>();
    const nextStarted = yield* Deferred.make<void>();
    let writes = 0;
    let fences = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.sync(() => String(++writes).padStart(64, "0")),
      confirm: (sha) =>
        sha === String(3).padStart(64, "0")
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.fail(new NarrowWriteFailure())),
              Effect.ensuring(Deferred.succeed(firstFinished, undefined)),
            )
          : sha === String(4).padStart(64, "0")
            ? Deferred.await(firstFinished).pipe(
                Effect.andThen(Deferred.succeed(nextStarted, undefined)),
                Effect.as({
                  capability_manifest: { sha256: sha, file_sha256: sha, reload_error: null },
                }),
              )
            : Effect.succeed({
                capability_manifest: { sha256: sha, file_sha256: sha, reload_error: null },
              }),
      fence: () =>
        Effect.sync(() => {
          fences++;
          return true;
        }),
      bind: (input) =>
        Effect.succeed({
          targetId: "target",
          tabId: `tab-${input.windowId}`,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const a = ThreadId.make("thread:a");
    const b = ThreadId.make("thread:b");
    for (const [threadId, windowId, origin] of [
      [a, 7, "https://a.test"],
      [b, 8, "https://b.test"],
    ] as const) {
      const result = yield* service.claim({
        threadId,
        pid: 42,
        windowId,
        origin,
        windowTitle: "Browser",
      });
      assert.equal(result.agentResult.status, "attached");
    }
    yield* service.stop(a);
    yield* Deferred.await(entered);
    yield* service.stop(b);
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(nextStarted);
    assert.equal(fences, 0);
  }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
);

it.effect("concurrent narrowings keep at most one confirmation in flight", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let writes = 0;
    let active = 0;
    let peak = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.sync(() => String(++writes).padStart(64, "0")),
      confirm: (sha) =>
        Effect.gen(function* () {
          active++;
          peak = Math.max(peak, active);
          if (sha === String(4).padStart(64, "0")) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          active--;
          return { capability_manifest: { sha256: sha, file_sha256: sha, reload_error: null } };
        }),
      fence: () => Effect.succeed(true),
      bind: (input) =>
        Effect.succeed({
          targetId: "target",
          tabId: `tab-${input.windowId}`,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threads = [
      ThreadId.make("thread:a"),
      ThreadId.make("thread:b"),
      ThreadId.make("thread:c"),
    ];
    for (const [index, threadId] of threads.entries()) {
      const result = yield* service.claim({
        threadId,
        pid: 42,
        windowId: index + 1,
        origin: `https://site${index}.test`,
        windowTitle: "Browser",
      });
      assert.equal(result.agentResult.status, "attached");
    }
    yield* service.stop(threads[0]!);
    yield* Deferred.await(entered);
    yield* service.stop(threads[1]!);
    yield* service.stop(threads[2]!);
    const observed = peak;
    yield* Deferred.succeed(release, undefined);
    assert.equal(observed, 1);
  }),
);

it.effect("a narrowing failure is fenced even after support was lowered", () =>
  Effect.gen(function* () {
    let supported = true;
    let failWrites = false;
    let fences = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => supported,
      publish: () =>
        failWrites ? Effect.fail(new NarrowWriteFailure()) : Effect.succeed("a".repeat(64)),
      confirm: () =>
        Effect.succeed({
          capability_manifest: {
            sha256: "a".repeat(64),
            file_sha256: "a".repeat(64),
            reload_error: null,
          },
        }),
      fence: () =>
        Effect.sync(() => {
          fences++;
          return true;
        }),
      bind: (input) =>
        Effect.succeed({
          targetId: "target",
          tabId: "tab",
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    assert.equal(
      (yield* service.claim({
        threadId,
        pid: 42,
        windowId: 7,
        origin: "https://example.test",
        windowTitle: "Browser",
      })).agentResult.status,
      "attached",
    );
    supported = false;
    failWrites = true;
    yield* service.stop(threadId);
    assert.equal(fences, 1);
  }),
);

it.effect("multiple narrowing failures record each and coalesce one follow-up fence", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let failWrites = false;
    let fences = 0;
    let marked = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () =>
        failWrites ? Effect.fail(new NarrowWriteFailure()) : Effect.succeed("a".repeat(64)),
      confirm: () =>
        Effect.succeed({
          capability_manifest: {
            sha256: "a".repeat(64),
            file_sha256: "a".repeat(64),
            reload_error: null,
          },
        }),
      fence: () =>
        Effect.gen(function* () {
          fences++;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return true;
        }),
      markFence: () => {
        marked++;
        return {
          run: Effect.sync(() => {
            fences++;
            return true;
          }),
        };
      },
      onConcurrentFence: () => Effect.void,
      bind: (input) =>
        Effect.succeed({
          targetId: "target",
          tabId: `tab-${input.windowId}`,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threads = [
      ThreadId.make("thread:a"),
      ThreadId.make("thread:b"),
      ThreadId.make("thread:c"),
    ];
    for (const [index, threadId] of threads.entries())
      assert.equal(
        (yield* service.claim({
          threadId,
          pid: 42,
          windowId: index + 1,
          origin: `https://site${index}.test`,
          windowTitle: "Browser",
        })).agentResult.status,
        "attached",
      );
    failWrites = true;
    const first = yield* service
      .stop(threads[0]!)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    yield* service.stop(threads[1]!);
    yield* service.stop(threads[2]!);
    const observed = { marked, fences };
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    assert.deepEqual(observed, { marked: 2, fences: 1 });
    assert.equal(fences, 2);
  }),
);

it.effect("direct stop writes use the live union after waiting for another write", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const manifests: Array<{
      readonly existingProfiles: ReadonlyArray<{ readonly pid: number; readonly windowId: number }>;
      readonly origins: ReadonlyArray<string>;
    }> = [];
    let hold = false;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (value) =>
        Effect.gen(function* () {
          manifests.push(value);
          if (hold) {
            hold = false;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
        }),
      bind: (input) =>
        Effect.succeed({
          targetId: "target",
          tabId: `tab-${input.windowId}`,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threads = [
      ThreadId.make("thread:a"),
      ThreadId.make("thread:b"),
      ThreadId.make("thread:c"),
    ];
    for (const [index, threadId] of threads.entries()) {
      const result = yield* service.claim({
        threadId,
        pid: 42,
        windowId: index + 1,
        origin: `https://site${index}.test`,
        windowTitle: "Browser",
      });
      assert.equal(result.agentResult.status, "attached");
    }
    hold = true;
    const first = yield* service
      .stop(threads[0]!)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const second = yield* service
      .stop(threads[1]!)
      .pipe(Effect.forkChild({ startImmediately: true }));
    const third = yield* service
      .stop(threads[2]!)
      .pipe(Effect.forkChild({ startImmediately: true }));
    assert.deepEqual(yield* service.claimsFor(threads[2]!), []);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* Fiber.join(third);
    assert.deepEqual(manifests.slice(-2), [
      { existingProfiles: [], origins: [] },
      { existingProfiles: [], origins: [] },
    ]);
  }),
);

it.effect("repeated stops do not rewrite an unchanged manifest", () =>
  Effect.gen(function* () {
    let writes = 0;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () =>
        Effect.sync(() => {
          writes++;
        }),
      bind: (input) =>
        Effect.succeed({
          targetId: "target",
          tabId: "tab",
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    const answer = yield* service.claim({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    assert.equal(answer.agentResult.status, "attached");
    yield* service.stop(threadId);
    const afterFirst = writes;
    yield* service.stop(threadId);
    assert.equal(writes, afterFirst);
  }),
);

it.effect("a failed narrowing write fences the driver", () =>
  Effect.gen(function* () {
    let failWrites = false;
    let fences = 0;
    const hash = "a".repeat(64);
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => (failWrites ? Effect.fail(new NarrowWriteFailure()) : Effect.succeed(hash)),
      confirm: () =>
        Effect.succeed({
          capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
        }),
      fence: () =>
        Effect.sync(() => {
          fences++;
          return true;
        }),
      bind: (input) =>
        Effect.succeed({
          targetId: "target",
          tabId: "tab",
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    const answer = yield* service.claim({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    assert.equal(answer.agentResult.status, "attached");
    failWrites = true;
    yield* service.stop(threadId);
    assert.equal(fences, 1);
  }),
);

it.effect("interrupting a held narrowing write still fences the driver", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hold = false;
    let fences = 0;
    const hash = "a".repeat(64);
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () =>
        hold
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.fail(new NarrowWriteFailure())),
            )
          : Effect.succeed(hash),
      confirm: () =>
        Effect.succeed({
          capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
        }),
      fence: () =>
        Effect.sync(() => {
          fences++;
          return true;
        }),
      bind: (input) =>
        Effect.succeed({
          targetId: "target",
          tabId: "tab",
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    const answer = yield* service.claim({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    assert.equal(answer.agentResult.status, "attached");
    hold = true;
    const stopping = yield* service
      .stop(threadId)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const interruption = yield* Fiber.interrupt(stopping).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interruption);
    assert.equal(fences, 1);
  }),
);

it.effect("stopping one thread ends its claims and preserves other claims and grants", () =>
  Effect.gen(function* () {
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: (input) =>
        Effect.succeed({
          targetId: "target-1",
          tabId: `tab-${input.windowId}`,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const first = ThreadId.make("thread:first");
    const other = ThreadId.make("thread:other");
    const a = yield* service.claim({
      threadId: first,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    const b = yield* service.claim({
      threadId: other,
      pid: 43,
      windowId: 8,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (a.agentResult.status !== "attached" || b.agentResult.status !== "attached")
      return assert.fail("expected attached claims");
    yield* service.stop(first);
    assert.equal(yield* service.endReason(first, a.agentResult.claim.claimId), "stopped");
    assert.lengthOf(yield* service.claimsFor(first), 0);
    assert.lengthOf(yield* service.claimsFor(other), 1);
    assert.lengthOf((yield* service.list(first)).grants, 1);
  }),
);

it.effect("stop fences a pending bind without waiting for it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: (input) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            targetId: "target-1",
            tabId: "tab",
            title: "Site",
            url: input.origin,
            driverGeneration: 1,
          }),
        ),
    });
    const threadId = ThreadId.make("thread:first");
    const pending = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (pending.status !== "pending") return assert.fail("expected pending");
    const answering = yield* service
      .answer(pending.claimId, true)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* service.stop(threadId);
    assert.equal((yield* Fiber.join(answering)).agentResult.status, "refused");
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(yield* service.claimsFor(threadId), []);
  }),
);
