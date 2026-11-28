import type { RoutedRequest } from "./PreviewAutomationBroker.testkit.ts";
import {
  makeHost,
  requestsFrom,
  scope,
  SERVER_BROWSER,
} from "./PreviewAutomationBroker.testkit.ts";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { expect, it } from "@effect/vitest";
import { PreviewTabId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
const makeBroker = PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));

const connectTabHost = Effect.fn("connectTabHost")(function* (
  broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) {
  const openTabs: PreviewTabId[] = [];
  const routed: RoutedRequest[] = [];
  const connected = yield* Deferred.make<void>();
  const requests = requestsFrom(
    yield* broker.connect(
      makeHost({ supportedOperations: ["open", "snapshot", "close"] }),
      SERVER_BROWSER,
    ),
    () => Deferred.doneUnsafe(connected, Effect.void),
  );
  yield* Stream.runForEach(requests, (request) => {
    routed.push(request);
    const reply = { clientId: "client-1", connectionId: request.connectionId };
    if (request.operation === "open") {
      const tabId = PreviewTabId.make(`tab-${routed.length}`);
      openTabs.push(tabId);
      return broker.respond({
        ...reply,
        requestId: request.requestId,
        ok: true,
        result: { tabId },
      });
    }
    const tabId = request.tabId ?? openTabs.at(-1);
    if (tabId === undefined || !openTabs.includes(tabId)) {
      return broker.respond({
        ...reply,
        requestId: request.requestId,
        ok: false,
        error: { _tag: "PreviewAutomationTabNotFoundError", message: "No tab." },
      });
    }
    if (request.operation === "close") openTabs.splice(openTabs.indexOf(tabId), 1);
    return broker.respond({ ...reply, requestId: request.requestId, ok: true, result: {} });
  }).pipe(Effect.forkScoped);
  yield* Deferred.await(connected);
  return { routed, openTabs };
});

const openTwoTabs = Effect.fn("openTwoTabs")(function* (
  broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) {
  const first = yield* broker.invoke<{ tabId: PreviewTabId }>({
    scope,
    operation: "open",
    input: {},
  });
  const second = yield* broker.invoke<{ tabId: PreviewTabId }>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false },
  });
  return [first.tabId, second.tabId] as const;
});

it.effect("forgets a current tab that closed elsewhere instead of naming it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const { routed, openTabs } = yield* connectTabHost(broker);
      yield* broker.invoke({ scope, operation: "open", input: {} });
      openTabs.splice(0);

      const error = yield* broker
        .invoke<void>({ scope, operation: "snapshot", input: {} })
        .pipe(Effect.flip);
      yield* broker.invoke({ scope, operation: "snapshot", input: {} }).pipe(Effect.ignore);

      expect(error.message).toBe(
        'No active preview tab was found for snapshot. Call goat_call {path:"preview.open"} first.',
      );
      expect(routed.at(-1)?.tabId).toBeUndefined();
    }),
  ),
);

it.effect("closing the current tab leaves implicit calls to the remaining tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const { routed } = yield* connectTabHost(broker);
      const [, second] = yield* openTwoTabs(broker);
      yield* broker.invoke({ scope, operation: "close", input: {}, tabId: second });

      yield* broker.invoke({ scope, operation: "snapshot", input: {} });

      expect(routed.at(-1)?.tabId).toBeUndefined();
    }),
  ),
);

it.effect("closing another tab keeps the current tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const { routed } = yield* connectTabHost(broker);
      const [first, second] = yield* openTwoTabs(broker);
      yield* broker.invoke({ scope, operation: "close", input: {}, tabId: first });

      yield* broker.invoke({ scope, operation: "snapshot", input: {} });

      expect(routed.at(-1)?.tabId).toBe(second);
    }),
  ),
);

it.effect("a late tab-not-found reply keeps a tab another call made current", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const tabA = PreviewTabId.make("tab-a");
      const tabB = PreviewTabId.make("tab-b");
      const connected = yield* Deferred.make<void>();
      const explicitSeen = yield* Deferred.make<void>();
      const implicitSeen = yield* Deferred.make<void>();
      const releaseExplicit = yield* Deferred.make<void>();
      const releaseImplicit = yield* Deferred.make<void>();
      const events = yield* broker.connect(makeHost());
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        const request = event.request;
        const reply = {
          clientId: "client-1",
          connectionId: event.connectionId,
          requestId: request.requestId,
        };
        const marker = (request.input as { marker?: string }).marker;
        return Effect.gen(function* () {
          if (marker === "explicit") {
            yield* Deferred.succeed(explicitSeen, undefined);
            yield* Deferred.await(releaseExplicit);
            yield* broker.respond({ ...reply, ok: true, result: { url: "tab-b" } });
          } else if (marker === "implicit") {
            yield* Deferred.succeed(implicitSeen, undefined);
            yield* Deferred.await(releaseImplicit);
            yield* broker.respond({
              ...reply,
              ok: false,
              error: { _tag: "PreviewAutomationTabNotFoundError", message: "Tab A closed." },
            });
          } else {
            yield* broker.respond({
              ...reply,
              ok: true,
              result: { url: request.tabId ?? "host-default" },
            });
          }
        }).pipe(Effect.forkScoped, Effect.asVoid);
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      yield* broker.invoke({ scope, operation: "snapshot", input: {}, tabId: tabA });
      const explicit = yield* broker
        .invoke({ scope, operation: "snapshot", input: { marker: "explicit" }, tabId: tabB })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(explicitSeen);
      const implicit = yield* broker
        .invoke<void>({ scope, operation: "snapshot", input: { marker: "implicit" } })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(implicitSeen);
      yield* Deferred.succeed(releaseExplicit, undefined);
      yield* Fiber.join(explicit);
      yield* Deferred.succeed(releaseImplicit, undefined);
      yield* Fiber.join(implicit);

      const result = yield* broker.invoke<{ url: string }>({
        scope,
        operation: "snapshot",
        input: {},
      });

      expect(result.url).toBe("tab-b");
    }),
  ),
);
