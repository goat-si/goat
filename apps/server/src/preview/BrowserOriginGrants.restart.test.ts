import { assert, it } from "@effect/vitest";
import { EnvironmentId, ExecutionEnvironmentDescriptor, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "../cua/CuaDriver.ts";
import { BrowserClaimBind } from "./BrowserClaimBind.ts";
import { BrowserClaimManifest } from "./BrowserClaimManifest.ts";
import * as Grants from "./BrowserOriginGrantsLayer.ts";
import { makeBrowserOriginGrants, type Union } from "./BrowserOriginGrants.ts";
import { active, call, harness } from "../cua/ComputerUseLeaseProxy.testkit.ts";

const decodeDescriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor);
const threadId = ThreadId.make("thread:test");
const input = {
  threadId,
  pid: 42,
  windowId: 7,
  origin: "https://example.test",
  windowTitle: "Browser",
};
const hash = "a".repeat(64);
const fixture = (published: Union[], bind: BrowserClaimBind["Service"]["bind"]) =>
  Grants.layer.pipe(
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
          publish: (value) =>
            Effect.sync(() => {
              published.push(value);
              return hash;
            }),
          readConfig: Effect.succeed({
            capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
          }),
          install: () => Effect.void,
        }),
        Layer.succeed(BrowserClaimBind, { bind }),
      ),
    ),
  );
const bound = (windowId: number) => ({
  targetId: "target-1",
  tabId: `tab-${windowId}`,
  title: "Site",
  url: input.origin,
  driverGeneration: 1,
});

it.effect(
  "restart ends the live claim, refuses pending requests, preserves grants and requires a new bind",
  () => {
    const published: Union[] = [];
    let binds = 0;
    return Effect.gen(function* () {
      const service = yield* Grants.BrowserOriginGrants;
      yield* service.setDriverCapability(true);
      const first = yield* service.request(input);
      if (first.status !== "pending") return assert.fail("expected pending");
      const answer = yield* service.answer(first.claimId, true);
      if (answer.agentResult.status !== "attached") return assert.fail("expected attached");
      const pending = yield* service.request({ ...input, windowId: 8 });
      if (pending.status !== "pending") return assert.fail("expected pending");
      yield* service.setDriverCapability(false);
      assert.equal(yield* service.endReason(threadId, first.claimId), "driver_restarted");
      assert.deepEqual(yield* service.claimsFor(threadId), []);
      assert.deepEqual(published.at(-1), { existingProfiles: [], origins: [] });
      const refused = (yield* service.answer(pending.claimId, true)).agentResult;
      assert.equal(refused.status, "refused");
      if (refused.status === "refused") assert.equal(refused.code, "declined");
      const state = yield* service.list(threadId);
      assert.lengthOf(state.grants, 1);
      yield* service.setDriverCapability(true);
      assert.deepEqual(yield* service.claimsFor(threadId), []);
      const next = yield* service.request(input);
      if (next.status !== "pending") return assert.fail("expected pending");
      const rebound = yield* service.answer(next.claimId, true);
      if (rebound.agentResult.status !== "attached") return assert.fail("expected attached");
      assert.isAbove(
        rebound.agentResult.claim.claimGeneration,
        answer.agentResult.claim.claimGeneration,
      );
      assert.equal(binds, 2);
    }).pipe(
      Effect.provide(
        fixture(published, (request) =>
          Effect.sync(() => {
            binds++;
            return bound(request.windowId);
          }),
        ),
      ),
    );
  },
);

it.effect(
  "restart drops the snapshot while another bind is held and fences a held proxy call",
  () =>
    Effect.gen(function* () {
      const published: Union[] = [];
      const bindStarted = yield* Deferred.make<void>();
      const releaseBind = yield* Deferred.make<void>();
      const restarted = yield* Deferred.make<void>();
      const answered = yield* Deferred.make<void>();
      const sendGate = yield* Deferred.make<void>();
      const proxy = yield* harness({
        autoAppListing: true,
        onTarget: () => true,
        targetGate: sendGate,
      });
      yield* Effect.gen(function* () {
        const service = yield* Grants.BrowserOriginGrants;
        yield* service.setDriverCapability(true);
        const first = yield* service.request(input);
        if (first.status !== "pending") return assert.fail("expected pending");
        const answer = yield* service.answer(first.claimId, true);
        if (answer.agentResult.status !== "attached") return assert.fail("expected attached");
        yield* proxy.push({ ...active(), browserClaims: yield* service.claimsFor(threadId) });
        yield* proxy.applied;
        yield* proxy.send(
          JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
        );
        yield* proxy.nextToDriver;
        yield* proxy.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            result: {
              tools: [
                { name: "get_browser_state", inputSchema: { properties: { origin_scope: {} } } },
              ],
            },
          }),
        );
        yield* proxy.nextToProvider;
        yield* proxy.send(call(1, "browser_click", { tab_id: "tab-7", pid: 42, window_id: 7 }));
        yield* proxy.reported;
        const second = yield* service.request({
          ...input,
          windowId: 8,
          origin: "https://other.test",
        });
        if (second.status !== "pending") return assert.fail("expected pending");
        const pendingAnswer = yield* service.answer(second.claimId, true).pipe(
          Effect.tap(() => Deferred.succeed(answered, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(bindStarted);
        assert.deepEqual((yield* service.claimsFor(threadId))[0]?.origins, [input.origin]);
        const fence = yield* service
          .setDriverCapability(false)
          .pipe(
            Effect.andThen(Deferred.succeed(restarted, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
        assert.isTrue(Option.isSome(yield* Deferred.poll(restarted)));
        yield* Fiber.join(fence);
        yield* Deferred.await(answered);
        assert.equal(yield* service.endReason(threadId, first.claimId), "driver_restarted");
        assert.equal(yield* service.endReason(threadId, second.claimId), "driver_restarted");
        yield* proxy.push({ ...active(), browserClaims: yield* service.claimsFor(threadId) });
        yield* proxy.applied;
        yield* Deferred.succeed(sendGate, undefined);
        assert.equal((yield* proxy.nextToProvider).id, 1);
        assert.equal(yield* proxy.driverQueued, 0);
        yield* service.setDriverCapability(true);
        yield* Deferred.succeed(releaseBind, undefined);
        const declined = yield* Fiber.join(pendingAnswer);
        assert.equal(declined.agentResult.status, "refused");
        if (declined.agentResult.status === "refused")
          assert.equal(declined.agentResult.code, "declined");
        assert.deepEqual(yield* service.claimsFor(threadId), []);
        assert.deepEqual(published.at(-1), { existingProfiles: [], origins: [] });
      }).pipe(
        Effect.provide(
          fixture(published, (request) =>
            request.windowId === 8
              ? Deferred.succeed(bindStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseBind)),
                  Effect.as(bound(8)),
                )
              : Effect.succeed(bound(7)),
          ),
        ),
      );
    }),
);

it.effect("the actual driver exit fences claims and preserves the person's grant", () => {
  const published: Union[] = [];
  return Effect.gen(function* () {
    const grants = yield* Grants.BrowserOriginGrants;
    const exited = yield* Deferred.make<void>();
    const watching = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const driver = yield* CuaDriver.make(
      () =>
        Effect.succeed({
          start: Effect.succeed({ command: "/fake", args: [], environment: [] }),
          stop: Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
          waitForExit: Deferred.succeed(watching, undefined).pipe(
            Effect.andThen(Deferred.await(exited)),
          ),
        }),
      Effect.succeed({ capability: "available", reason: "test", environment: [] }),
      {
        probeBrowserClaims: () =>
          Effect.succeed({
            tools: [
              { name: "get_browser_state", inputSchema: { properties: { origin_scope: {} } } },
            ],
          }),
        setDriverCapability: (value) => grants.setDriverCapability(value).pipe(Effect.ignore),
      },
    );
    yield* driver.acquire;
    yield* Deferred.await(watching);
    const request = yield* grants.request(input);
    if (request.status !== "pending") return assert.fail("expected pending");
    const answer = yield* grants.answer(request.claimId, true);
    if (answer.agentResult.status !== "attached") return assert.fail("expected attached");
    yield* Deferred.succeed(exited, undefined);
    yield* Deferred.await(stopped);
    assert.equal(yield* grants.endReason(threadId, request.claimId), "driver_restarted");
    assert.deepEqual(yield* grants.claimsFor(threadId), []);
    assert.lengthOf((yield* grants.list(threadId)).grants, 1);
    assert.deepEqual(published.at(-1), { existingProfiles: [], origins: [] });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        fixture(published, (request) => Effect.succeed(bound(request.windowId))),
        ServerSettings.layerTest({ enableCua: true }),
      ),
    ),
  );
});

it.effect("restart refuses an answer while manifest confirmation is held", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<unknown>();
    let supported = true;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => supported,
      publish: () => Effect.succeed(hash),
      confirm: () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      bind: (request) => Effect.succeed(bound(request.windowId)),
    });
    const request = yield* service.request(input);
    if (request.status !== "pending") return assert.fail("expected pending");
    const answer = yield* service
      .answer(request.claimId, true)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* service.driverRestarted(() => {
      supported = false;
    });
    const result = yield* Fiber.join(answer);
    assert.equal(result.agentResult.status, "refused");
    if (result.agentResult.status === "refused") assert.equal(result.agentResult.code, "declined");
    yield* Deferred.succeed(release, {
      capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
    });
    assert.deepEqual(yield* service.claimsFor(threadId), []);
  }),
);

it.effect("restart refuses a held publication and writes the empty union after it completes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const published: Union[] = [];
    let supported = true;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => supported,
      publish: (value) =>
        (value.existingProfiles.length > 0
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              published.push(value);
              return hash;
            }),
          ),
        ),
      confirm: () =>
        Effect.succeed({
          capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
        }),
      bind: (request) => Effect.succeed(bound(request.windowId)),
    });
    const request = yield* service.request(input);
    if (request.status !== "pending") return assert.fail("expected pending");
    const answer = yield* service
      .answer(request.claimId, true)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    const restart = yield* service
      .driverRestarted(() => {
        supported = false;
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    const result = yield* Fiber.join(answer);
    assert.equal(result.agentResult.status, "refused");
    assert.deepEqual(yield* service.claimsFor(threadId), []);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(restart);
    assert.deepEqual(
      published.map((value) => value.existingProfiles),
      [[{ pid: 42, windowId: 7 }], []],
    );
  }),
);
