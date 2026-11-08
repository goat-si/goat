import { assert, it } from "@effect/vitest";
import { EnvironmentId, ExecutionEnvironmentDescriptor, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Context from "effect/Context";
import { serverAdmitsBrowserCall } from "../cua/ComputerUseLeaseProxyBrowserClaims.ts";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Grants from "./BrowserOriginGrantsLayer.ts";
import { BrowserClaimManifest } from "./BrowserClaimManifest.ts";
import { BrowserClaimBind } from "./BrowserClaimBind.ts";
import { makeCuaCommittedPolicy, type CuaCommittedPolicyRead } from "../cuaCommittedPolicy.ts";

const decodeDescriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor);
class ManifestUnavailable extends Schema.TaggedError<ManifestUnavailable>()(
  "ManifestUnavailable",
  {},
) {}

it.effect("persistent manifest failures do not reenter the driver lifecycle fence", () =>
  Effect.gen(function* () {
    let failWrites = false;
    let revoke = Effect.void;
    const lifecycle = yield* Semaphore.make(1);
    const finished = yield* Deferred.make<void>();
    const hash = "a".repeat(64);
    const context = yield* Layer.build(
      Grants.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest(),
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
                failWrites ? Effect.fail(new ManifestUnavailable()) : Effect.succeed(hash),
              readConfig: Effect.succeed({
                capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
              }),
              fence: lifecycle.withPermit(Effect.suspend(() => revoke)).pipe(Effect.as(true)),
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
    revoke = service.setDriverCapability(false);
    yield* service.setDriverCapability(true);
    const input = {
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    };
    assert.equal((yield* service.claim(input)).agentResult.status, "attached");
    failWrites = true;
    yield* service.stop(input.threadId).pipe(
      Effect.tap(() => Deferred.succeed(finished, undefined)),
      Effect.forkDetach({ startImmediately: true }),
    );
    assert.isTrue(
      Option.isSome(yield* Deferred.poll(finished)),
      "fence must finish without reentering lifecycle",
    );
    assert.equal((yield* service.request(input)).status, "refused");
    assert.deepEqual(yield* service.claimsFor(input.threadId), []);
    failWrites = false;
    yield* service.setDriverCapability(true);
    assert.equal((yield* service.claim(input)).agentResult.status, "attached");
    failWrites = true;
    const restartFinished = yield* Deferred.make<void>();
    yield* lifecycle.withPermit(service.setDriverCapability(false)).pipe(
      Effect.tap(() => Deferred.succeed(restartFinished, undefined)),
      Effect.forkDetach({ startImmediately: true }),
    );
    assert.isTrue(
      Option.isSome(yield* Deferred.poll(restartFinished)),
      "external revocation must finish",
    );
    assert.equal((yield* service.request(input)).status, "refused");
  }).pipe(Effect.scoped),
);

it.effect("a failed driver fence disables further browser claims", () =>
  Effect.gen(function* () {
    let failWrites = false;
    const hash = "a".repeat(64);
    const context = yield* Layer.build(
      Grants.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest(),
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
                failWrites ? Effect.fail(new ManifestUnavailable()) : Effect.succeed(hash),
              readConfig: Effect.succeed({
                capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
              }),
              fence: Effect.succeed(false),
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
    const input = {
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    };
    const claim = yield* service.claim(input);
    assert.equal(claim.agentResult.status, "attached");
    failWrites = true;
    yield* service.stop(input.threadId);
    assert.equal((yield* service.request(input)).status, "refused");
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

it.effect("a settings change ends blocked claims and pending requests without a browser call", () =>
  Effect.gen(function* () {
    const base = Context.get(
      yield* Layer.build(ServerSettings.layerTest()),
      ServerSettings.ServerSettingsService,
    );
    const events = yield* Queue.unbounded<void>();
    const processed = yield* Deferred.make<void>();
    const fenced = yield* Deferred.make<void>();
    let failPublish = false;
    const stream = Stream.fromQueue(events).pipe(
      Stream.mapEffect(() => base.getSettings.pipe(Effect.orDie)),
    );
    let subscribed = false;
    const settings = {
      ...base,
      subscribeChanges: Effect.sync(() => {
        subscribed = true;
        return stream;
      }),
    };
    const environment = Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed(
        decodeDescriptor({
          environmentId: EnvironmentId.make("environment:test"),
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "test",
          capabilities: { repositoryIdentity: true },
        }),
      ),
    });
    const manifest = Layer.succeed(BrowserClaimManifest, {
      publish: (union) =>
        (failPublish
          ? Effect.fail(new ManifestUnavailable())
          : union.origins.length === 0
            ? Deferred.succeed(processed, undefined)
            : Effect.void
        ).pipe(Effect.as("a".repeat(64))),
      fence: Deferred.succeed(fenced, undefined).pipe(Effect.as(true)),
      readConfig: Effect.succeed({
        capability_manifest: {
          sha256: "a".repeat(64),
          file_sha256: "a".repeat(64),
          reload_error: null,
        },
      }),
      install: () => Effect.void,
    });
    const bind = Layer.succeed(BrowserClaimBind, {
      bind: (request) =>
        Effect.succeed({
          targetId: "target-1",
          tabId: "tab",
          title: "Site",
          url: request.origin,
          driverGeneration: 1,
        }),
    });
    const context = yield* Layer.build(
      Grants.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            environment,
            manifest,
            bind,
            Layer.succeed(ServerSettings.ServerSettingsService, settings),
          ),
        ),
      ),
    );
    const service = Context.get(context, Grants.BrowserOriginGrants);
    yield* service.setDriverCapability(true);
    const threadId = ThreadId.make("thread:blocked");
    const input = {
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    };
    const answer = yield* service.claim(input);
    if (answer.agentResult.status !== "attached") return assert.fail("expected attached");
    const claim = answer.agentResult.claim;
    const pending = yield* service.request({ ...input, windowId: 8 });
    if (pending.status !== "pending") return assert.fail("expected pending");
    assert.lengthOf((yield* service.snapshotFor(threadId)).claims, 1);
    yield* settings.updateSettings({ blockedBrowserHosts: ["example.test"] });
    assert.deepEqual((yield* base.getSettings).blockedBrowserHosts, ["example.test"]);
    yield* Queue.offer(events, undefined);
    if (subscribed) yield* Deferred.await(processed);
    const listed = yield* service.list(threadId);
    assert.deepEqual(listed.claims, []);
    assert.includeDeepMembers(listed.ended ?? [], [
      { claimId: claim.claimId, reason: "blocked_url" },
    ]);
    assert.notInclude(
      (listed.ended ?? []).map((item) => item.claimId),
      pending.claimId,
    );
    assert.isUndefined((yield* service.list(ThreadId.make("thread:other"))).ended);
    assert.equal(yield* service.endReason(threadId, claim.claimId), "blocked_url");
    const snapshot = yield* service.snapshotFor(threadId);
    assert.deepEqual(snapshot.claims, []);
    const refused = (yield* service.answer(pending.claimId, true)).agentResult;
    assert.equal(refused.status === "refused" && refused.code, "declined");
    assert.isFalse(
      serverAdmitsBrowserCall(
        "browser_click",
        {
          tab_id: "tab",
          target_id: "target-1",
          session: `goat-claim:${claim.claimId}`,
          origin_scope: [input.origin],
        },
        snapshot,
      ),
    );
    const other = yield* service.claim({ ...input, origin: "https://other.test" });
    if (other.agentResult.status !== "attached") return assert.fail("expected other claim");
    failPublish = true;
    yield* settings.updateSettings({ blockedBrowserHosts: ["other.test"] });
    yield* Queue.offer(events, undefined);
    yield* Deferred.await(fenced);
    assert.equal(
      yield* service.endReason(threadId, other.agentResult.claim.claimId),
      "blocked_url",
    );
    assert.deepEqual((yield* service.snapshotFor(threadId)).claims, []);
  }).pipe(Effect.scoped),
);

const buildPolicyGrants = (
  committedPolicy: CuaCommittedPolicyRead,
  publish: (union: { readonly origins: ReadonlyArray<string> }) => Effect.Effect<string>,
) =>
  Effect.gen(function* () {
    const base = Context.get(
      yield* Layer.build(ServerSettings.layerTest()),
      ServerSettings.ServerSettingsService,
    );
    const hash = "a".repeat(64);
    const context = yield* Layer.build(
      Grants.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerSettings.ServerSettingsService, {
              ...base,
              committedPolicy,
              subscribeChanges: Effect.succeed(Stream.empty),
            }),
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
              publish,
              readConfig: Effect.succeed({
                capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
              }),
              install: () => Effect.void,
            }),
            Layer.succeed(BrowserClaimBind, {
              bind: (request) =>
                Effect.succeed({
                  targetId: "target",
                  tabId: "tab",
                  title: "Site",
                  url: request.origin,
                  driverGeneration: 1,
                }),
            }),
          ),
        ),
      ),
    );
    const service = Context.get(context, Grants.BrowserOriginGrants);
    yield* service.setDriverCapability(true);
    const threadId = ThreadId.make("thread:blocked");
    const answer = yield* service.claim({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (answer.agentResult.status !== "attached") return yield* Effect.die("expected attached");
    return { service, threadId, claimId: answer.agentResult.claim.claimId };
  });

it.effect("a committed blocked-host publication ends the claim without a settings event", () =>
  Effect.gen(function* () {
    const policy = yield* makeCuaCommittedPolicy;
    const release = yield* Deferred.make<void>();
    const initial = yield* Context.get(
      yield* Layer.build(ServerSettings.layerTest()),
      ServerSettings.ServerSettingsService,
    ).getSettings;
    yield* policy.publish(initial, Option.none());
    const { service, threadId, claimId } = yield* buildPolicyGrants(policy.read, (union) =>
      union.origins.length === 0
        ? Deferred.await(release).pipe(Effect.as("a".repeat(64)))
        : Effect.succeed("a".repeat(64)),
    );
    yield* policy.publish({ ...initial, blockedBrowserHosts: ["example.test"] }, Option.none());
    // The claim ends while the narrowing manifest write is still held.
    const reason = yield* service.changes.pipe(
      Stream.mapEffect(() => service.endReason(threadId, claimId)),
      Stream.filter((value) => value !== undefined),
      Stream.runHead,
    );
    assert.deepEqual(reason, Option.some("blocked_url"));
    assert.deepEqual((yield* service.snapshotFor(threadId)).claims, []);
    yield* Deferred.succeed(release, undefined);
  }).pipe(Effect.scoped),
);

it.effect("unchanged committed publications are acknowledged and leave the claim live", () =>
  Effect.gen(function* () {
    const feed = yield* Queue.unbounded<ReadonlyArray<string> | undefined>();
    const acknowledged = yield* Queue.unbounded<void>();
    const committedPolicy = Object.assign(
      Effect.succeed({ _tag: "committed" as const, enableCua: true, blockedBrowserHosts: [] }),
      {
        changes: Stream.fromQueue(feed),
        hostsNow: () => [],
        acknowledge: () => void Queue.offerUnsafe(acknowledged, undefined),
      },
    );
    const { service, threadId, claimId } = yield* buildPolicyGrants(committedPolicy, () =>
      Effect.succeed("a".repeat(64)),
    );
    for (let index = 0; index < 3; index++) {
      Queue.offerUnsafe(feed, []);
      yield* Queue.take(acknowledged);
    }
    assert.equal(yield* service.endReason(threadId, claimId), undefined);
    assert.equal((yield* service.snapshotFor(threadId)).claims.length, 1);
  }).pipe(Effect.scoped),
);
it.effect(
  "a committed publication blocks a new claim and the next manifest without a settings event",
  () =>
    Effect.gen(function* () {
      const base = Context.get(
        yield* Layer.build(ServerSettings.layerTest()),
        ServerSettings.ServerSettingsService,
      );
      const initial = yield* base.getSettings;
      const policy = yield* makeCuaCommittedPolicy;
      yield* policy.publish(initial, Option.none());
      const published = yield* Queue.unbounded<ReadonlyArray<string>>();
      const hash = "a".repeat(64);
      const settings = {
        ...base,
        committedPolicy: policy.read,
        subscribeChanges: Effect.succeed(Stream.empty),
      };
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
                publish: (union) =>
                  Effect.sync(() => {
                    Queue.offerUnsafe(published, union.origins);
                    return hash;
                  }),
                readConfig: Effect.succeed({
                  capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
                }),
                install: () => Effect.void,
              }),
              Layer.succeed(BrowserClaimBind, {
                bind: (request) =>
                  Effect.succeed({
                    targetId: "target-" + String(request.windowId),
                    tabId: "tab-" + String(request.windowId),
                    title: "Site",
                    url: request.origin,
                    driverGeneration: 1,
                  }),
              }),
            ),
          ),
        ),
      );
      const service = Context.get(context, Grants.BrowserOriginGrants);
      yield* service.setDriverCapability(true);
      const threadId = ThreadId.make("thread:blocked");
      const claimFor = (windowId: number, origin: string) =>
        service.claim({ threadId, pid: 42, windowId, origin, windowTitle: "Browser" });
      const kept = yield* claimFor(7, "https://b.test");
      const blocked = yield* claimFor(8, "https://a.test");
      if (kept.agentResult.status !== "attached" || blocked.agentResult.status !== "attached")
        return assert.fail("expected attached claims");
      yield* policy.publish({ ...initial, blockedBrowserHosts: ["a.test"] }, Option.none());
      const requested = yield* service.request({
        threadId,
        pid: 42,
        windowId: 9,
        origin: "https://a.test",
        windowTitle: "Browser",
      });
      const answered =
        requested.status === "pending" ? yield* service.answer(requested.claimId, true) : requested;
      const refusal = "agentResult" in answered ? answered.agentResult : answered;
      assert.equal(refusal.status, "refused");
      if (refusal.status === "refused") assert.equal(refusal.code, "blocked_url");
      let manifest = yield* Queue.take(published);
      while (manifest.includes("https://a.test")) manifest = yield* Queue.take(published);
      assert.deepEqual(manifest, ["https://b.test"]);
      assert.lengthOf((yield* service.snapshotFor(threadId)).claims, 1);
    }).pipe(Effect.scoped),
);
