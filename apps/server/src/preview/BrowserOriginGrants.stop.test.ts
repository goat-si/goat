import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
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

it.effect("narrowing failures during a fence coalesce and stopped claims stay refused", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let failWrites = false;
    let fences = 0;
    let marked = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      blockedHostsNow: () => [],
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
    const judges: Array<Effect.Effect<unknown>> = [];
    for (const [index, threadId] of threads.entries()) {
      const { agentResult } = yield* service.claim({
        threadId,
        pid: 42,
        windowId: index + 1,
        origin: `https://site${index}.test`,
        windowTitle: "Browser",
      });
      if (agentResult.status !== "attached") throw new Error("Expected an attached claim");
      const { claimId, claimGeneration } = agentResult.claim;
      const args = {
        tab_id: `tab-${index + 1}`,
        target_id: "target",
        session: `goat-claim:${claimId}`,
        origin_scope: [`https://site${index}.test`],
      };
      const judge = service.judgeClaimCall(threadId, "get_browser_state", args, {
        claimId,
        claimGeneration,
      });
      assert.equal(yield* judge, "admit");
      judges.push(judge);
    }
    failWrites = true;
    const first = yield* service
      .stop(threads[0]!)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    yield* service.stop(threads[1]!);
    yield* service.stop(threads[2]!);
    const observed = { marked, fences };
    for (const judge of judges) assert.notEqual(yield* judge, "admit");
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
      {
        existingProfiles: [
          { pid: 42, windowId: 2 },
          { pid: 42, windowId: 3 },
        ],
        origins: ["https://site1.test", "https://site2.test"],
      },
      { existingProfiles: [], origins: [] },
    ]);
  }),
);

it.effect.each([
  { name: "stale revoke", action: "revoke" },
  { name: "person end", action: "endPerson" },
  { name: "claim end", action: "end" },
  { name: "thread stop", action: "stop" },
] as const)("$name does not publish when the browser union does not narrow", ({ action }) =>
  Effect.gen(function* () {
    let writes = 0;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () =>
        Effect.sync(() => {
          writes++;
        }),
      bind: (request) =>
        Effect.succeed({
          targetId: "target",
          tabId: "tab",
          title: "Site",
          url: request.origin,
          driverGeneration: 1,
        }),
    });
    const firstThread = ThreadId.make("thread:first");
    const secondThread = ThreadId.make("thread:second");
    const input = { pid: 42, windowId: 7, origin: "https://example.test", windowTitle: "Browser" };
    const first = yield* service.claim({ ...input, threadId: firstThread });
    const second = yield* service.claim({ ...input, threadId: secondThread });
    if (first.agentResult.status !== "attached" || second.agentResult.status !== "attached")
      return assert.fail("expected claims");
    const before = yield* service.snapshotFor(firstThread);
    const beforeWrites = writes;
    if (action === "revoke") yield* service.revoke(firstThread, "https://absent.test");
    else if (action === "endPerson") yield* service.endPerson(first.agentResult.claim.claimId);
    else if (action === "end")
      yield* service.end(
        firstThread,
        first.agentResult.claim.claimId,
        first.agentResult.claim.claimGeneration,
        "origin_changed",
      );
    else yield* service.stop(firstThread);
    assert.equal(writes, beforeWrites);
    assert.lengthOf(yield* service.claimsFor(secondThread), 1);
    const after = yield* service.snapshotFor(firstThread);
    if (action === "revoke") assert.equal(after.revision, before.revision);
    else {
      assert.isAbove(after.revision, before.revision);
      assert.isEmpty(after.claims);
    }
  }),
);

it.effect("revoking an inactive saved grant does not publish an unchanged union", () =>
  Effect.gen(function* () {
    let writes = 0;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () =>
        Effect.sync(() => {
          writes++;
        }),
      bind: (request) =>
        Effect.succeed({
          targetId: "target",
          tabId: "tab",
          title: "Site",
          url: request.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    const input = {
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    };
    assert.equal((yield* service.claim(input)).agentResult.status, "attached");
    yield* service.stop(threadId);
    const before = writes;
    yield* service.revoke(threadId, input.origin);
    assert.equal(writes, before);
    assert.deepEqual((yield* service.list(threadId)).grants, []);
  }),
);

it.effect("unchanged blocked hosts do not republish an unchanged union", () =>
  Effect.gen(function* () {
    let writes = 0;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () =>
        Effect.sync(() => {
          writes++;
        }),
      bind: (request) =>
        Effect.succeed({
          targetId: "target",
          tabId: "tab",
          title: "Site",
          url: request.origin,
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
    const before = writes;
    yield* service.blockedHostsChanged([]);
    assert.equal(writes, before);
    assert.lengthOf(yield* service.claimsFor(threadId), 1);
  }),
);

it.effect("blocking a saved active grant narrows once", () =>
  Effect.gen(function* () {
    let hosts: ReadonlyArray<string> = [];
    const published: Array<ReadonlyArray<string>> = [];
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      blockedHosts: Effect.sync(() => hosts),
      publish: (value) =>
        Effect.sync(() => {
          published.push(value.origins);
        }),
      bind: (request) =>
        Effect.succeed({
          targetId: "target",
          tabId: "tab",
          title: "Site",
          url: request.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    for (const [windowId, origin] of [
      [7, "https://a.test"],
      [8, "https://b.test"],
    ] as const) {
      assert.equal(
        (yield* service.claim({ threadId, pid: 42, windowId, origin, windowTitle: "Browser" }))
          .agentResult.status,
        "attached",
      );
    }
    const b = (yield* service.claimsFor(threadId)).find((claim) => claim.windowId === 8);
    if (!b) return assert.fail("expected b claim");
    yield* service.endPerson(b.claimId);
    assert.deepEqual(published.at(-1), ["https://a.test", "https://b.test"]);
    hosts = ["b.test"];
    yield* service.blockedHostsChanged(hosts);
    assert.deepEqual(published.at(-1), ["https://a.test"]);
    const count = published.length;
    yield* service.blockedHostsChanged(hosts);
    assert.equal(published.length, count);
  }),
);

it.effect("restarting with an empty union does not publish a manifest", () =>
  Effect.gen(function* () {
    let writes = 0;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => false,
      publish: () =>
        Effect.sync(() => {
          writes++;
        }),
      bind: () => Effect.die("unused"),
    });
    const before = yield* service.snapshotFor(ThreadId.make("thread:test"));
    yield* service.driverRestarted(() => {});
    const after = yield* service.snapshotFor(ThreadId.make("thread:test"));
    assert.equal(writes, 0);
    assert.isAbove(after.revision, before.revision);
  }),
);

it.effect("a failed duplicate bind does not republish an unchanged union", () =>
  Effect.gen(function* () {
    let writes = 0;
    let binds = 0;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () =>
        Effect.sync(() => {
          writes++;
        }),
      bind: (request) =>
        ++binds === 1
          ? Effect.succeed({
              targetId: "target",
              tabId: "tab",
              title: "Site",
              url: request.origin,
              driverGeneration: 1,
            })
          : Effect.fail(new NarrowWriteFailure()),
    });
    const input = {
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    };
    assert.equal((yield* service.claim(input)).agentResult.status, "attached");
    assert.equal((yield* service.claim(input)).agentResult.status, "refused");
    assert.equal(writes, 2);
    assert.lengthOf(yield* service.claimsFor(input.threadId), 1);
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

it.effect(
  "a published block refuses the next claimed call before the manifest write finishes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.ignore));
        let hold = false;
        let hosts: ReadonlyArray<string> = [];
        const service = yield* makeTestBrowserOriginGrants({
          environmentId: EnvironmentId.make("environment:test"),
          supported: () => true,
          blockedHostsNow: () => hosts,
          publish: () =>
            hold
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          bind: (request) =>
            Effect.succeed({
              targetId: "target",
              tabId: "tab-b",
              title: "Site",
              url: request.origin,
              driverGeneration: 1,
            }),
        });
        const threadId = ThreadId.make("thread:blocked");
        const claimFor = (windowId: number, origin: string) =>
          service.claim({ threadId, pid: 42, windowId, origin, windowTitle: "Browser" });
        const kept = yield* claimFor(8, "https://b.test");
        const ending = yield* claimFor(7, "https://a.test");
        if (kept.agentResult.status !== "attached" || ending.agentResult.status !== "attached")
          return assert.fail("expected attached");
        hold = true;
        hosts = ["b.test"];
        const publishing = yield* service
          .blockedHostsChanged(["a.test"])
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const admitted = yield* Deferred.make<string>();
        const admission = yield* service
          .admitClaimCall(
            threadId,
            "browser_click",
            { tab_id: "tab-b", url: "https://b.test/secret" },
            [],
          )
          .pipe(
            Effect.tap((decision) => Deferred.succeed(admitted, decision.status)),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Effect.yieldNow;
        const polled = yield* Deferred.poll(admitted);
        if (Option.isNone(polled)) return assert.fail("admission waited on the manifest write");
        assert.equal(yield* polled.value, "blocked");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(admission);
        yield* Fiber.join(publishing);
      }),
    ),
);
