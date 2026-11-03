import { assert, it } from "@effect/vitest";
import { EnvironmentId, ExecutionEnvironmentDescriptor, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Grants from "./BrowserOriginGrantsLayer.ts";
import { BrowserClaimManifest } from "./BrowserClaimManifest.ts";
import { BrowserClaimBind } from "./BrowserClaimBind.ts";
import { makeTestBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";
import { makeCuaCommittedPolicy } from "../cuaCommittedPolicy.ts";

const decodeDescriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor);

it.effect("claims stay unavailable when committed policy changes cannot be observed", () =>
  Effect.gen(function* () {
    const base = Context.get(
      yield* Layer.build(ServerSettings.layerTest()),
      ServerSettings.ServerSettingsService,
    );
    const settings = { ...base };
    delete settings.committedPolicyChanges;
    const context = yield* Layer.build(
      Grants.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerSettings.ServerSettingsService, settings),
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
              publish: () => Effect.succeed("a".repeat(64)),
              readConfig: Effect.succeed({}),
              install: () => Effect.void,
            }),
          ),
        ),
      ),
    );
    const service = Context.get(context, Grants.BrowserOriginGrants);
    yield* service.setDriverCapability(true);
    const result = yield* service.request({
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    assert.equal(result.status, "refused");
  }).pipe(Effect.scoped),
);

it.effect("a policy block and restore without settings events ends a live claim", () =>
  Effect.gen(function* () {
    const base = Context.get(
      yield* Layer.build(ServerSettings.layerTest()),
      ServerSettings.ServerSettingsService,
    );
    const initial = yield* base.getSettings;
    const policy = yield* makeCuaCommittedPolicy;
    yield* policy.publish(initial, Option.none());
    const subscribed = yield* Deferred.make<void>();
    const settings = {
      ...base,
      committedPolicy: policy.read,
      committedPolicyChanges: policy.subscribeRestrictions.pipe(
        Effect.tap(() => Deferred.succeed(subscribed, undefined)),
      ),
      subscribeChanges: Effect.succeed(Stream.empty),
    };
    const hash = "a".repeat(64);
    const context = yield* Layer.build(
      Grants.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerSettings.ServerSettingsService, settings),
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
              publish: () => Effect.succeed(hash),
              readConfig: Effect.succeed({
                capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
              }),
              install: () => Effect.void,
            }),
            Layer.succeed(BrowserClaimBind, {
              bind: (input) =>
                Effect.succeed({
                  targetId: "target",
                  tabId: "tab",
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
    const threadId = ThreadId.make("thread:test");
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending");
    yield* service.answer(request.claimId, true);
    const changes = yield* service.changes.pipe(Stream.toQueue({ capacity: "unbounded" }));
    yield* Queue.take(changes);
    yield* policy.publish({ ...initial, blockedBrowserHosts: ["example.test"] }, Option.none());
    yield* policy.publish(initial, Option.none());
    if (yield* Deferred.isDone(subscribed)) yield* Queue.take(changes);
    assert.deepEqual(yield* service.claimsFor(threadId), []);
    assert.equal(yield* service.endReason(threadId, request.claimId), "origin_changed");
  }).pipe(Effect.scoped),
);

it.effect("a no-URL reply is refused when its claim origin is blocked before observation", () =>
  Effect.gen(function* () {
    let hosts: ReadonlyArray<string> = [];
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      blockedHosts: () => hosts,
      publish: () => Effect.void,
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
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending");
    const answer = yield* service.answer(request.claimId, true);
    if (answer.agentResult.status !== "attached") return assert.fail("expected attached");
    hosts = ["example.test"];
    assert.isFalse(
      yield* service.judgeReply(
        threadId,
        request.claimId,
        answer.agentResult.claim.claimGeneration,
        [],
        false,
      ),
    );
    assert.equal(yield* service.endReason(threadId, request.claimId), "origin_changed");
  }),
);

it.effect("a block followed by an unblock still ends an existing claim", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const processed = yield* Deferred.make<void>();
    const base = Context.get(
      yield* Layer.build(ServerSettings.layerTest()),
      ServerSettings.ServerSettingsService,
    );
    const feed = base.committedPolicyChanges;
    if (feed === undefined) return assert.fail("missing policy feed");
    const settings = {
      ...base,
      committedPolicyChanges: feed.pipe(
        Effect.map((stream) =>
          stream.pipe(
            Stream.drop(1),
            Stream.mapEffect((value) =>
              value !== undefined && value.length > 0
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(value),
                  )
                : Deferred.succeed(processed, undefined).pipe(Effect.as(value)),
            ),
          ),
        ),
      ),
    };
    const hash = "a".repeat(64);
    const context = yield* Layer.build(
      Grants.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerSettings.ServerSettingsService, settings),
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
              publish: () => Effect.succeed(hash),
              readConfig: Effect.succeed({
                capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
              }),
              install: () => Effect.void,
            }),
            Layer.succeed(BrowserClaimBind, {
              bind: (input) =>
                Effect.succeed({
                  targetId: "target",
                  tabId: "tab",
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
    const threadId = ThreadId.make("thread:test");
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending");
    yield* service.answer(request.claimId, true);
    yield* settings.updateSettings({ blockedBrowserHosts: ["example.test"] });
    yield* Deferred.await(entered);
    yield* settings.updateSettings({ blockedBrowserHosts: [] });
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(processed);
    assert.equal(yield* service.endReason(threadId, request.claimId), "origin_changed");
    assert.deepEqual(yield* service.claimsFor(threadId), []);
  }).pipe(Effect.scoped),
);

it.effect("reports unsupported capability as unavailable and removes claims from snapshots", () =>
  Effect.gen(function* () {
    const service = yield* Grants.BrowserOriginGrants;
    const input = {
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    };
    yield* service.setDriverCapability(true);
    const pending = yield* service.request(input);
    if (pending.status !== "pending") return assert.fail("expected pending");
    yield* service.answer(pending.claimId, true);
    assert.lengthOf(yield* service.claimsFor(input.threadId), 1);
    yield* service.setDriverCapability(false);
    const result = yield* service.request(input);
    assert.equal(result.status, "refused");
    if (result.status === "refused") assert.equal(result.code, "unavailable");
    assert.deepEqual(yield* service.claimsFor(input.threadId), []);
    assert.deepEqual(yield* service.claimedPids(), []);
  }).pipe(
    Effect.provide(
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
              publish: () => Effect.succeed("a".repeat(64)),
              readConfig: Effect.succeed({
                capability_manifest: {
                  sha256: "a".repeat(64),
                  file_sha256: "a".repeat(64),
                  reload_error: null,
                },
              }),
              install: () => Effect.void,
            }),
            Layer.succeed(BrowserClaimBind, {
              bind: () =>
                Effect.succeed({
                  targetId: "target-1",
                  tabId: "tab",
                  title: "Site",
                  url: "https://example.test",
                  driverGeneration: 1,
                }),
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("refuses an approved claim as unavailable when the bind service is absent", () =>
  Effect.gen(function* () {
    const service = yield* Grants.BrowserOriginGrants;
    yield* service.setDriverCapability(true);
    const request = yield* service.request({
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending");
    const answer = yield* service.answer(request.claimId, true);
    assert.equal(answer.agentResult.status, "refused");
    if (answer.agentResult.status === "refused")
      assert.equal(answer.agentResult.code, "unavailable");
    assert.deepEqual(yield* service.claimedPids(), []);
  }).pipe(
    Effect.provide(
      Grants.layer.pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.merge(
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
              publish: () => Effect.succeed("a".repeat(64)),
              readConfig: Effect.succeed({
                capability_manifest: {
                  sha256: "a".repeat(64),
                  file_sha256: "a".repeat(64),
                  reload_error: null,
                },
              }),
              install: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect(
  "keeps claims unavailable without a publisher even after driver capability is reported",
  () =>
    Effect.gen(function* () {
      const service = yield* Grants.BrowserOriginGrants;
      yield* service.setDriverCapability(true);
      const result = yield* service.request({
        threadId: ThreadId.make("thread:test"),
        pid: 42,
        windowId: 7,
        origin: "https://example.test",
        windowTitle: "Browser",
      });
      assert.equal(result.status, "refused");
      if (result.status === "refused") assert.equal(result.code, "unavailable");
      assert.deepEqual(yield* service.claimsFor(ThreadId.make("thread:test")), []);
      assert.deepEqual(yield* service.claimedPids(), []);
    }).pipe(
      Effect.provide(
        Grants.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
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
          ),
        ),
      ),
    ),
);

it.effect("does not publish a browser union while driver capability is unavailable", () => {
  let writes = 0;
  return Effect.gen(function* () {
    const service = yield* Grants.BrowserOriginGrants;
    const result = yield* service.request({
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    assert.equal(result.status, "refused");
    if (result.status === "refused") assert.equal(result.code, "unavailable");
    assert.equal(writes, 0);
  }).pipe(
    Effect.provide(
      Grants.layer.pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.merge(
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
                Effect.sync(() => {
                  writes++;
                  return "a".repeat(64);
                }),
              readConfig: Effect.succeed({
                capability_manifest: {
                  sha256: "a".repeat(64),
                  file_sha256: "a".repeat(64),
                  reload_error: null,
                },
              }),
              install: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );
});
