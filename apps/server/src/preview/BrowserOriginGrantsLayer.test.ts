import { assert, it } from "@effect/vitest";
import { EnvironmentId, ExecutionEnvironmentDescriptor, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
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
