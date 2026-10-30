import { assert, it } from "@effect/vitest";
import { EnvironmentId, ExecutionEnvironmentDescriptor, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Grants from "./BrowserOriginGrantsLayer.ts";
import { BrowserClaimManifest } from "./BrowserClaimManifest.ts";

it.effect("refuses an approved claim as unavailable when the bind service is absent", () =>
  Effect.gen(function* () {
    const service = yield* Grants.BrowserOriginGrants;
    yield* service.reportDriverCapability(true);
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
                Schema.decodeSync(ExecutionEnvironmentDescriptor)({
                  environmentId: EnvironmentId.make("environment:test"),
                  label: "Test",
                  platform: { os: "linux", arch: "x64" },
                  serverVersion: "test",
                  capabilities: { repositoryIdentity: true },
                }),
              ),
            }),
            Layer.succeed(BrowserClaimManifest, { publish: () => Effect.void }),
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
      yield* service.reportDriverCapability(true);
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
                Schema.decodeSync(ExecutionEnvironmentDescriptor)({
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
