import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { makeTestBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";
import { makeBrowserOriginGrants } from "./BrowserOriginGrants.ts";

class NarrowWriteFailure extends Schema.TaggedError<NarrowWriteFailure>()(
  "NarrowWriteFailure",
  {},
) {}

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
    const threadId = ThreadId.make("thread:first");
    const claim = yield* service.claim({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    assert.equal(claim.agentResult.status, "attached");
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

it.effect("repeated stops do not publish or confirm when no claims remain", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hold = false;
    let writes = 0;
    let confirmations = 0;
    const hash = "a".repeat(64);
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () =>
        Effect.sync(() => {
          writes++;
          return hash;
        }),
      confirm: () =>
        hold
          ? Effect.sync(() => {
              confirmations++;
            }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
              }),
            )
          : Effect.succeed({
              capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
            }),
      fence: () => Effect.succeed(true),
      bind: (input) =>
        Effect.succeed({
          targetId: "target",
          tabId: "tab",
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:first");
    const claim = yield* service.claim({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    assert.equal(claim.agentResult.status, "attached");
    hold = true;
    yield* service.stop(threadId);
    yield* Deferred.await(entered);
    for (let i = 0; i < 3; i++) yield* service.stop(threadId);
    const observed = { writes, confirmations };
    yield* Deferred.succeed(release, undefined);
    yield* service.settled;
    assert.deepEqual(observed, { writes: 2, confirmations: 1 });
  }),
);

it.effect("concurrent narrowings keep at most one confirmation in flight", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let writes = 0;
    let active = 0;
    let peak = 0;
    const confirmed: string[] = [];
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.sync(() => String(++writes).padStart(64, "0")),
      confirm: (sha) =>
        Effect.gen(function* () {
          active++;
          peak = Math.max(peak, active);
          confirmed.push(sha);
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
          tabId: "tab-" + input.windowId,
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
    yield* Deferred.succeed(release, undefined);
    yield* service.settled;
    assert.equal(peak, 1);
    assert.equal(confirmed.at(-1), String(6).padStart(64, "0"));
  }),
);

it.effect("a coalesced narrowing fences when a later union is not its subset", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let writes = 0;
    let fences = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.sync(() => String(++writes).padStart(64, "0")),
      confirm: (sha) =>
        (sha === String(4).padStart(64, "0")
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void
        ).pipe(
          Effect.as({ capability_manifest: { sha256: sha, file_sha256: sha, reload_error: null } }),
        ),
      fence: () =>
        Effect.sync(() => {
          fences++;
          return true;
        }),
      bind: (input) =>
        Effect.succeed({
          targetId: "target",
          tabId: "tab-" + input.windowId,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threads = [
      ThreadId.make("thread:a"),
      ThreadId.make("thread:b"),
      ThreadId.make("thread:c"),
      ThreadId.make("thread:d"),
    ];
    const attach = Effect.fnUntraced(function* (index: number) {
      const threadId = threads[index];
      if (threadId === undefined) return yield* Effect.die("missing thread");
      const result = yield* service.claim({
        threadId,
        pid: 42,
        windowId: index + 1,
        origin: `https://site${index}.test`,
        windowTitle: "Browser",
      });
      assert.equal(result.agentResult.status, "attached");
    });
    yield* attach(0);
    yield* attach(1);
    yield* attach(2);
    yield* service.stop(threads[0]!);
    yield* Deferred.await(entered);
    yield* service.stop(threads[1]!);
    yield* attach(3);
    yield* service.stop(threads[2]!);
    const fencedBeforeRelease = fences;
    yield* Deferred.succeed(release, undefined);
    yield* service.settled;
    assert.equal(fencedBeforeRelease, 1);
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
