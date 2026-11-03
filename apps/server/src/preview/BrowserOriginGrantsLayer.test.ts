import { assert, it } from "@effect/vitest";
import { EnvironmentId, ExecutionEnvironmentDescriptor, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
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

const decodeDescriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor);

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
        (union.origins.length === 0 ? Deferred.succeed(processed, undefined) : Effect.void).pipe(
          Effect.as("a".repeat(64)),
        ),
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
      bind: () =>
        Effect.succeed({
          targetId: "target-1",
          tabId: "tab",
          title: "Site",
          url: "https://example.test",
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
    assert.deepEqual((yield* service.list(threadId)).claims, []);
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
  }).pipe(Effect.scoped),
);
