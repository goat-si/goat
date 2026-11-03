import { assert, it } from "@effect/vitest";
import { EnvironmentId, ExecutionEnvironmentDescriptor, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BrowserClaimManifest } from "./BrowserClaimManifest.ts";
import { BrowserClaimBind } from "./BrowserClaimBind.ts";
import * as Grants from "./BrowserOriginGrantsLayer.ts";
import { makeTestBrowserOriginGrants as makeBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";
import { makeBrowserOriginGrants as makeUnconfirmedGrants } from "./BrowserOriginGrants.ts";

const decodeDescriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor);

it.effect("a blocked origin cannot be granted or bound", () =>
  Effect.gen(function* () {
    let hosts: ReadonlyArray<string> = ["example.test"];
    let binds = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      blockedHosts: () => hosts,
      publish: () => Effect.void,
      bind: (input) =>
        Effect.sync(() => {
          binds++;
          return {
            targetId: "target",
            tabId: "tab",
            title: "Site",
            url: input.origin,
            driverGeneration: 1,
          };
        }),
    });
    const input = {
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    };
    assert.equal((yield* service.request(input)).status, "refused");
    hosts = [];
    const pending = yield* service.request(input);
    if (pending.status !== "pending") return assert.fail("expected pending");
    hosts = ["example.test"];
    assert.equal((yield* service.answer(pending.claimId, true)).agentResult.status, "refused");
    assert.equal(binds, 0);
    assert.deepEqual(yield* service.list(input.threadId), { grants: [], claims: [] });
    assert.deepEqual(yield* service.bindingsFor(input.threadId), []);
  }),
);

it.effect("does not bind before approval and hides a mismatch as a decline", () =>
  Effect.gen(function* () {
    const manifests: Array<unknown> = [];
    let binds = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (union) => Effect.sync(() => void manifests.push(union)),
      bind: () =>
        Effect.sync(() => {
          binds++;
          return {
            targetId: "target-1",
            tabId: "tab-1",
            title: "Private",
            url: "https://other.test/",
            driverGeneration: 1,
          };
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
    const first = yield* service.request(input);
    assert.equal(first.status, "pending");
    assert.equal(binds, 0);
    if (first.status !== "pending") return;
    const mismatch = yield* service.answer(first.claimId, true);
    const second = yield* service.request(input);
    if (second.status !== "pending") return assert.fail("expected pending request");
    const decline = yield* service.answer(second.claimId, false);
    assert.deepEqual(mismatch.agentResult, decline.agentResult);
    assert.equal(
      "personMessage" in mismatch ? mismatch.personMessage : undefined,
      "This tab is not on https://example.test",
    );
    assert.deepEqual((yield* service.list(threadId)).grants, []);
    assert.equal(binds, 1);
    assert.deepEqual(manifests.at(-1), { existingProfiles: [], origins: [] });
  }),
);

it.effect("keeps grants per thread and shrinks the exact window union on revoke and stop", () =>
  Effect.gen(function* () {
    const manifests: Array<{
      readonly existingProfiles: ReadonlyArray<{ readonly pid: number; readonly windowId: number }>;
      readonly origins: ReadonlyArray<string>;
    }> = [];
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (value) => Effect.sync(() => void manifests.push(value)),
      bind: (input) =>
        Effect.succeed({
          targetId: "target-1",
          tabId: `tab-${input.windowId}`,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const a = ThreadId.make("thread:a");
    const b = ThreadId.make("thread:b");
    for (const [threadId, windowId, origin] of [
      [a, 7, "https://one.test"],
      [b, 8, "https://two.test"],
    ] as const) {
      const request = yield* service.request({
        threadId,
        pid: 42,
        windowId,
        origin,
        windowTitle: "Browser",
      });
      if (request.status !== "pending") return assert.fail("expected pending request");
      yield* service.answer(request.claimId, true);
    }
    assert.deepEqual(manifests.at(-1), {
      existingProfiles: [
        { pid: 42, windowId: 7 },
        { pid: 42, windowId: 8 },
      ],
      origins: ["https://one.test", "https://two.test"],
    });
    assert.deepEqual(
      (yield* service.list(a)).grants.map((grant) => grant.origin),
      ["https://one.test"],
    );
    yield* service.revoke(a, "https://one.test");
    assert.deepEqual(manifests.at(-1), {
      existingProfiles: [{ pid: 42, windowId: 8 }],
      origins: ["https://two.test"],
    });
    yield* service.stop(b);
    assert.deepEqual(manifests.at(-1), { existingProfiles: [], origins: [] });
  }),
);

it.effect("does not grant a noncanonical origin or use an unsupported driver", () =>
  Effect.gen(function* () {
    let supported = false;
    let published = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => supported,
      publish: () =>
        Effect.sync(() => {
          published++;
        }),
      bind: () => Effect.die("bind must not run"),
    });
    const input = {
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test/",
      windowTitle: "Browser",
    };
    const unavailable = yield* service.request(input);
    assert.equal(unavailable.status, "refused");
    if (unavailable.status === "refused") assert.equal(unavailable.code, "unavailable");
    supported = true;
    const invalid = yield* service.request(input);
    assert.equal(invalid.status, "refused");
    if (invalid.status === "refused") assert.equal(invalid.code, "invalid_origin");
    assert.equal(published, 0);
  }),
);

it.effect("serializes a revoke behind an in-flight bind", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            targetId: "target-1",
            tabId: "tab",
            title: "Site",
            url: "https://example.test",
            driverGeneration: 1,
          }),
        ),
    });
    const threadId = ThreadId.make("thread:test");
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending request");
    const answer = yield* service.answer(request.claimId, true).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const revoked = yield* service.revoke(threadId, "https://example.test").pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(answer);
    yield* Fiber.join(revoked);
    assert.deepEqual(yield* service.list(threadId), { grants: [], claims: [] });
  }),
);

it.effect("ends only the matching claim generation when its origin changes", () =>
  Effect.gen(function* () {
    const manifests: Array<unknown> = [];
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (value) => Effect.sync(() => void manifests.push(value)),
      bind: () =>
        Effect.succeed({
          targetId: "target-1",
          tabId: "tab-1",
          title: "Site",
          url: "https://example.test/",
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending request");
    const answer = yield* service.answer(request.claimId, true);
    if (answer.agentResult.status !== "attached") return assert.fail("expected attached claim");
    const generation = answer.agentResult.claim.claimGeneration;
    const stale = yield* service.end(threadId, request.claimId, generation + 1, "origin_changed");
    assert.isFalse(stale);
    assert.lengthOf((yield* service.list(threadId)).claims, 1);
    const ended = yield* service.end(threadId, request.claimId, generation, "origin_changed");
    assert.isTrue(ended);
    assert.equal(yield* service.endReason(threadId, request.claimId), "origin_changed");
    assert.deepEqual((yield* service.list(threadId)).claims, []);
    assert.deepEqual(manifests.at(-1), { existingProfiles: [], origins: [] });
  }),
);

it.effect("exposes each thread's claims and fences claimed browser pids until revoked", () =>
  Effect.gen(function* () {
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: () =>
        Effect.succeed({
          targetId: "target-1",
          tabId: "tab-1",
          title: "Site",
          url: "https://example.test",
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending request");
    const answer = yield* service.answer(request.claimId, true);
    if (answer.agentResult.status !== "attached") return assert.fail("expected attached claim");
    assert.deepEqual(yield* service.claimsFor(threadId), [
      {
        claimId: request.claimId,
        claimGeneration: answer.agentResult.claim.claimGeneration,
        pid: 42,
        windowId: 7,
        targetId: "target-1",
        tabId: "tab-1",
        origins: ["https://example.test"],
      },
    ]);
    assert.deepEqual(yield* service.claimsFor(ThreadId.make("thread:other")), []);
    assert.deepEqual(yield* service.claimedPids(), [42]);
    assert.isFalse(
      yield* service.end(
        ThreadId.make("thread:other"),
        request.claimId,
        answer.agentResult.claim.claimGeneration,
        "origin_changed",
      ),
    );
    yield* service.revoke(threadId, "https://example.test");
    assert.deepEqual(yield* service.claimsFor(threadId), []);
    assert.deepEqual(yield* service.claimedPids(), []);
  }),
);

class ManifestConfirmationMismatch extends Schema.TaggedError<ManifestConfirmationMismatch>()(
  "ManifestConfirmationMismatch",
  {},
) {}

it.effect("a narrowing superseded by a newer applied narrowing does not restart the driver", () =>
  Effect.gen(function* () {
    let written = 0;
    let fences = 0;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* makeUnconfirmedGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.sync(() => String(++written).padStart(64, "0")),
      confirm: (sha) =>
        sha === String(3).padStart(64, "0")
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.fail(new ManifestConfirmationMismatch())),
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
          targetId: "target-1",
          tabId: "tab-" + input.windowId,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    for (const [windowId, origin] of [
      [7, "https://example.test"],
      [8, "https://other.test"],
    ] as const) {
      const request = yield* service.request({
        threadId,
        pid: 42,
        windowId,
        origin,
        windowTitle: "Browser",
      });
      if (request.status !== "pending") return assert.fail("expected pending");
      yield* service.answer(request.claimId, true);
    }
    yield* service.revoke(threadId, "https://example.test");
    yield* Deferred.await(entered);
    yield* service.revoke(threadId, "https://other.test");
    yield* Deferred.succeed(release, undefined);
    yield* service.settled;
    assert.equal(fences, 0);
  }),
);

it.effect("an expansion between two narrowings does not hide a failed narrowing", () =>
  Effect.gen(function* () {
    let written = 0;
    let fences = 0;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* makeUnconfirmedGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.sync(() => String(++written).padStart(64, "0")),
      confirm: (sha) =>
        sha === String(3).padStart(64, "0")
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.fail(new ManifestConfirmationMismatch())),
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
          targetId: "target-1",
          tabId: "tab-" + input.windowId,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    const attach = Effect.fnUntraced(function* (windowId: number, origin: string) {
      const request = yield* service.request({
        threadId,
        pid: 42,
        windowId,
        origin,
        windowTitle: "Browser",
      });
      if (request.status !== "pending") return yield* Effect.die("expected pending");
      yield* service.answer(request.claimId, true);
    });
    yield* attach(7, "https://example.test");
    yield* attach(8, "https://other.test");
    yield* service.revoke(threadId, "https://example.test");
    yield* Deferred.await(entered);
    yield* attach(9, "https://third.test");
    yield* service.revoke(threadId, "https://other.test");
    yield* Deferred.succeed(release, undefined);
    yield* service.settled;
    assert.equal(fences, 1);
  }),
);

it.effect("restarts the driver when a narrower manifest cannot be written", () =>
  Effect.gen(function* () {
    let failWrites = false;
    let fences = 0;
    const service = yield* makeUnconfirmedGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () =>
        failWrites
          ? Effect.fail(new ManifestConfirmationMismatch())
          : Effect.succeed("a".repeat(64)),
      confirm: (sha) =>
        Effect.succeed({
          capability_manifest: { sha256: sha, file_sha256: sha, reload_error: null },
        }),
      fence: () =>
        Effect.sync(() => {
          fences++;
          return true;
        }),
      bind: (input) =>
        Effect.succeed({
          targetId: "target-1",
          tabId: "tab-1",
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending request");
    yield* service.answer(request.claimId, true);
    failWrites = true;
    yield* service.revoke(threadId, "https://example.test").pipe(Effect.result);
    assert.equal(fences, 1);
  }),
);

it.effect("a failed fence stops new claims", () =>
  Effect.gen(function* () {
    let failWrites = false;
    const hash = "a".repeat(64);
    const context = yield* Layer.build(
      Grants.layer.pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getDescriptor: Effect.succeed(
                decodeDescriptor({
                  environmentId: EnvironmentId.make("environment:test"),
                  label: "Test",
                  platform: { os: "linux", arch: "x64" },
                  serverVersion: "test",
                  capabilities: { repositoryIdentity: true },
                }),
              ),
            }),
            Layer.succeed(BrowserClaimManifest, {
              publish: () =>
                failWrites ? Effect.fail(new ManifestConfirmationMismatch()) : Effect.succeed(hash),
              readConfig: Effect.succeed({
                capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
              }),
              fence: Effect.succeed(false),
              install: () => Effect.void,
            }),
            Layer.succeed(BrowserClaimBind, {
              bind: (input) =>
                Effect.succeed({
                  targetId: "target-1",
                  tabId: "tab-1",
                  title: "Site",
                  url: input.origin,
                  driverGeneration: 1,
                }),
            }),
          ),
        ),
      ),
    );
    const service = Context.get(context, Grants.BrowserOriginGrants);
    yield* service.setDriverCapability(true);
    const input = {
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    };
    const request = yield* service.request(input);
    if (request.status !== "pending") return assert.fail("expected pending request");
    yield* service.answer(request.claimId, true);
    failWrites = true;
    yield* service.revoke(input.threadId, input.origin);
    const next = yield* service.request(input);
    assert.equal(next.status, "refused");
    if (next.status === "refused") assert.equal(next.code, "unavailable");
  }).pipe(Effect.scoped),
);

it.effect("refuses a claim when manifest confirmation fails and restores the previous union", () =>
  Effect.gen(function* () {
    const published: Array<ReadonlyArray<{ readonly pid: number; readonly windowId: number }>> = [];
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (union) =>
        Effect.gen(function* () {
          published.push(union.existingProfiles);
          if (union.existingProfiles.some((entry) => entry.windowId === 8))
            return yield* new ManifestConfirmationMismatch();
        }),
      bind: (input) =>
        Effect.succeed({
          targetId: "target-1",
          tabId: `tab-${input.windowId}`,
          title: "Site",
          url: input.origin,
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
    const first = yield* service.request(input);
    if (first.status !== "pending") return assert.fail("expected pending request");
    const accepted = yield* service.answer(first.claimId, true);
    assert.equal(accepted.agentResult.status, "attached");
    const second = yield* service.request({ ...input, windowId: 8 });
    if (second.status !== "pending") return assert.fail("expected pending request");
    const answer = yield* service.answer(second.claimId, true);
    assert.equal(answer.agentResult.status, "refused");
    assert.deepEqual(published.at(-1), [{ pid: 42, windowId: 7 }]);
    assert.lengthOf(yield* service.claimsFor(threadId), 1);
  }),
);

it.effect("restarts the driver when it will not confirm a narrower manifest", () =>
  Effect.gen(function* () {
    const hash = "b".repeat(64);
    let rejectReload = false;
    const fenced = yield* Deferred.make<void>();
    const service = yield* makeUnconfirmedGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.succeed(hash),
      confirm: () =>
        Effect.sync(() => ({
          capability_manifest: {
            sha256: hash,
            file_sha256: hash,
            reload_error: rejectReload ? "reload refused" : null,
          },
        })),
      fence: () => Deferred.succeed(fenced, undefined).pipe(Effect.as(true)),
      bind: (input) =>
        Effect.succeed({
          targetId: "target-1",
          tabId: "tab-1",
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const threadId = ThreadId.make("thread:test");
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending request");
    const answer = yield* service.answer(request.claimId, true);
    assert.equal(answer.agentResult.status, "attached");
    assert.isFalse(yield* Deferred.isDone(fenced));
    rejectReload = true;
    yield* service.revoke(threadId, "https://example.test");
    yield* Deferred.await(fenced);
    assert.deepEqual(yield* service.claimsFor(threadId), []);
  }),
);
