import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ComputerUsePrimitiveChannel from "../cua/ComputerUsePrimitiveChannel.ts";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as BrowserClaimBind from "../preview/BrowserClaimBind.ts";
import * as ScreenCodeLayers from "./ScreenCodeLayers.ts";

const isBindFailure = Schema.is(BrowserClaimBind.BrowserClaimBindFailure);

class TestBinder extends Context.Service<
  TestBinder,
  BrowserClaimBind.BrowserClaimBind["Service"]
>()("goat/screenCode/ScreenCodeClaimBind.test/TestBinder") {}

it.effect("installs the primitive binder into the same service used by claims", () =>
  Effect.gen(function* () {
    const signals = yield* PubSub.unbounded<void>();
    const app = Layer.effect(TestBinder, BrowserClaimBind.BrowserClaimBind);
    const layer = ScreenCodeLayers.provideScreenPrimitives(app).pipe(
      Layer.provideMerge(BrowserClaimBind.layer),
      Layer.provide(
        Layer.mock(ComputerUseLeases.ComputerUseLeases)({
          subscribe: PubSub.subscribe(signals),
          currentControl: () => Effect.succeedNone,
          proxy: undefined,
        }),
      ),
    );
    const outcome = yield* Effect.gen(function* () {
      const binder = yield* TestBinder;
      return yield* binder
        .bind({
          claimId: "claim:1",
          bindingVersion: 1,
          threadId: ThreadId.make("thread:one"),
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Browser",
        })
        .pipe(Effect.result);
    }).pipe(Effect.provide(layer));
    assert.isTrue(Result.isFailure(outcome));
    if (Result.isFailure(outcome)) {
      if (!isBindFailure(outcome.failure)) return assert.fail("wrong error");
      assert.isObject(outcome.failure.cause);
    }
  }).pipe(Effect.scoped),
);

it.effect("the installed binder uses the same live primitive channel exposed to the server", () =>
  Effect.gen(function* () {
    const signals = yield* PubSub.unbounded<void>();
    const threadId = ThreadId.make("thread:one");
    const controlId = "control:one";
    const expiresAt = DateTime.makeUnsafe(60_000);
    const app = Layer.effect(TestBinder, BrowserClaimBind.BrowserClaimBind);
    const layer = ScreenCodeLayers.provideScreenPrimitives(app).pipe(
      Layer.provideMerge(BrowserClaimBind.layer),
      Layer.provide(
        Layer.mock(ComputerUseLeases.ComputerUseLeases)({
          subscribe: PubSub.subscribe(signals),
          currentControl: () => Effect.succeedSome({ controlId, threadId, expiresAt }),
          controlState: () =>
            Effect.succeed({
              _tag: "active",
              expiresAt,
              interruptions: { count: 0, last: "human_input" },
              apps: undefined,
              wakeAt: 60_000,
            }),
          proxy: undefined,
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const binder = yield* TestBinder;
      const channel = yield* ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel;
      const authority = {
        threadId,
        attachmentGeneration: "attachment:one",
        proxyChannelToken: "token:one",
      };
      yield* channel.issue({ ...authority, controlId, expiresAt: 60_000 });
      const registered = yield* channel.registerStream({
        ...authority,
        proxyInstanceId: "proxy:one",
        kind: "thread",
      });
      if (registered.status !== "registered") return assert.fail("registration failed");
      assert.isTrue(
        yield* channel.reportControlReady({
          ...authority,
          registrationId: registered.registrationId,
          controlId,
          connectionId: "driver:zero",
          driverGeneration: 0,
        }),
      );
      const bind = yield* binder
        .bind({
          claimId: "claim:1",
          bindingVersion: 2,
          threadId,
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Browser",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const request = Option.getOrThrow(
        yield* registered.requests.pipe(
          Stream.filter((value) => value.state === "primitive-request"),
          Stream.runHead,
        ),
      );
      if (request.state !== "primitive-request") return assert.fail("missing primitive");
      assert.equal(request.authority, "claimBind");
      assert.equal(request.bindingVersion, 2);
      yield* channel.reply({
        ...authority,
        registrationId: registered.registrationId,
        reply: {
          requestId: request.requestId,
          registrationId: request.registrationId,
          controlId: request.controlId,
          connectionGeneration: request.connectionGeneration,
          runId: request.runId,
          turnId: request.turnId,
          callId: request.callId,
          status: "settled",
          result: {
            structuredContent: {
              mode: "bind",
              tabs: [{ tab_id: "tab", active: true, title: "Site", url: "https://example.test/" }],
            },
          },
        },
      });
      assert.deepEqual(yield* Fiber.join(bind), {
        tabId: "tab",
        title: "Site",
        url: "https://example.test/",
        driverGeneration: 1,
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
