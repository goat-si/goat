import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  Handoff,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type ProviderHomeRequestAction,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Settings from "../serverSettings.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as HomeRequests from "./CodexHomeRequests.ts";
import * as HomeRoute from "./OpenCodexRoute.ts";
import * as Routes from "./CodexRouteService.ts";
import {
  caller,
  commitAndApply,
  environmentId,
  instanceId,
  layer,
  sessionId,
} from "./CodexRouteService.testkit.ts";
const decode = Schema.decodeUnknownSync(CodexSettings);
const approval = (action: ProviderHomeRequestAction) =>
  Effect.gen(function* () {
    const routes = yield* Routes.CodexRouteService;
    const settings = yield* Settings.ServerSettingsService;
    yield* settings.start;
    const config = decode({ modelRoute: action === "disconnect" ? "opencodex" : "default" });
    const instance = {
      driver: ProviderDriverKind.make("codex"),
      displayName: "Approved A",
      config,
    };
    yield* commitAndApply(
      routes.mutateProviderInstance(
        { mutation: { operation: "create", instanceId, instance } },
        caller,
      ),
    );
    const captured = yield* routes.capture(instanceId);
    const now = yield* DateTime.now;
    const handoff: Handoff = {
      handoffId: TurnItemId.make("provider-home-approval-a"),
      kind: "approval",
      title: "Review Home",
      reason: "Route review",
      requestedBy: {
        threadId: ThreadId.make("owner-thread"),
        providerInstanceId: instanceId,
        path: "provider.home_request",
      },
      target: { environmentId, path: "provider.home_request" },
      dedupeKey: "test-a",
      state: "completed",
      createdAt: now,
      expiresAt: DateTime.add(now, { minutes: 15 }),
      actor: { type: "client", label: "Reviewer" },
    };
    const args = {
      version: 1,
      request: { instanceId, action },
      instance,
      expectedFingerprint: captured.fingerprint,
      expectedRevision: captured.revision,
      environmentId,
    };
    const read = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let finished = 0;
    const dependencies = Layer.mergeAll(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Handoffs.Handoffs)({
        completedProviderHomeContinuations: Effect.succeed([
          { handoff, args, approvedBySessionId: sessionId },
        ]),
        open: () => Effect.succeed({ handoff, human: null }),
        finishProviderHomeContinuation: () =>
          Effect.sync(() => {
            finished++;
          }),
      }),
      Layer.succeed(HomeRoute.OpenCodexRoute, {
        inspect: () => Effect.die("Not used by approval executor"),
        launchArgs: () => Effect.die("Not used by approval executor"),
        requireAvailable: () =>
          Deferred.succeed(read, undefined).pipe(Effect.andThen(Deferred.await(resume))),
      }),
    );
    const requests = Context.get(
      yield* Layer.build(HomeRequests.layer.pipe(Layer.provide(dependencies))),
      HomeRequests.CodexHomeRequests,
    );
    return { routes, requests, read, resume, instance, finished: () => finished };
  });
it.effect(
  "preserves a competing UI edit when approval admission resumes after the executor read",
  () =>
    Effect.gen(function* () {
      const f = yield* approval("connect");
      const executor = yield* f.requests.resumeContinuations.pipe(Effect.forkScoped);
      yield* Deferred.await(f.read);
      yield* commitAndApply(
        f.routes.mutateProviderInstance(
          {
            mutation: {
              operation: "upsert",
              instanceId,
              instance: {
                ...f.instance,
                displayName: "Competing UI B",
                config: { ...f.instance.config, launchArgs: "--enable explicit_b" },
              },
            },
          },
          caller,
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const before = yield* fs.readFileString(config.settingsPath);
      const revision = (yield* f.routes.capture(instanceId)).revision;
      yield* Deferred.succeed(f.resume, undefined);
      yield* Fiber.join(executor);
      const result = yield* f.routes.capture(instanceId);
      assert.equal(result.instance.displayName, "Competing UI B");
      assert.deepStrictEqual(result.revision, revision);
      assert.equal(yield* fs.readFileString(config.settingsPath), before);
      assert.equal(f.finished(), 1);
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "applies the approved default reversal through the same mutation service without probing Home",
  () =>
    Effect.gen(function* () {
      const f = yield* approval("disconnect");
      yield* commitAndApply(f.requests.resumeContinuations);
      const config = decode((yield* f.routes.capture(instanceId)).instance.config);
      assert.equal(config.modelRoute, "default");
      assert.isFalse(yield* Deferred.isDone(f.read));
      assert.equal(f.finished(), 1);
    }).pipe(Effect.provide(layer)),
);
it.effect("rejects an outside-thread request without creating a fake approval", () =>
  Effect.gen(function* () {
    const f = yield* approval("disconnect");
    const result = yield* f.requests.request(
      { instanceId, action: "connect" },
      {
        environmentId,
        readOnly: false,
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
        requestNamespace: "external-agent",
        thread: undefined,
        client: undefined,
      },
    );
    assert.equal(result.kind, "error");
    if (result.kind === "error") assert.equal(result.code, "unsupported");
    assert.equal(f.finished(), 0);
  }).pipe(Effect.provide(layer)),
);
