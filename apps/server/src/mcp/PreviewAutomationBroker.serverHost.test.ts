import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  ProviderInstanceId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationStreamEvent,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const makeBroker = PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));
const scope = {
  environmentId: EnvironmentId.make("environment-server-host"),
  requestNamespace: "provider-session-server-host",
  thread: {
    threadId: ThreadId.make("thread-server-host"),
    providerSessionId: "provider-session-server-host",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const makeHost = (overrides: Partial<PreviewAutomationHost> = {}): PreviewAutomationHost => ({
  clientId: "client-1",
  environmentId: scope.environmentId,
  ...overrides,
});
/** The server browser connects in process; only it opens tabs and fills secrets. */
const SERVER_BROWSER = { inProcess: true } as const;
const requestsFrom = (events: Stream.Stream<PreviewAutomationStreamEvent>) =>
  events.pipe(
    Stream.filterMap((event) =>
      event.type === "connected"
        ? Result.failVoid
        : Result.succeed({ ...event.request, connectionId: event.connectionId }),
    ),
  );

it.effect(
  "an open never reaches a client host, which cannot open a tab in the requested session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const requests = requestsFrom(yield* broker.connect(makeHost({ clientId: "desktop-app" })));
        let received = 0;
        yield* Stream.runForEach(requests, () => Effect.sync(() => void received++)).pipe(
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        const error = yield* broker
          .invoke<void>({ scope, operation: "open", input: { session: "isolated" } })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
        expect(received).toBe(0);
      }),
    ),
);

it.effect("says why a secret fill could not use its secretRef", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const clientId = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
      const host = makeHost({ clientId, supportedOperations: ["fillSecret"] });
      const requests = requestsFrom(yield* broker.connect(host, SERVER_BROWSER));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId,
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationSecretFillRefusedError",
            message: "That secretRef is for another site, so nothing was filled.",
            detail: { beforeInput: true, secretFailure: "not_permitted" },
          },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const error = yield* broker
        .invoke<void>({ scope, operation: "fillSecret", input: {} })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        secretFailure: "not_permitted",
        dispatched: false,
      });
    }),
  ),
);

it.effect.each([
  { clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID, shown: true },
  { clientId: "client-1", shown: false },
])("tells the agent why its own server browser failed ($clientId)", ({ clientId, shown }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost({ clientId }), SERVER_BROWSER));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId,
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationExecutionError",
            message: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4719/",
          },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const error = yield* broker
        .invoke<void>({ scope, operation: "open", input: {} })
        .pipe(Effect.flip);
      expect(error._tag).toBe("PreviewAutomationExecutionError");
      expect(error.message.includes("ERR_CONNECTION_REFUSED")).toBe(shown);
    }),
  ),
);

it.effect("names how many elements an ambiguous selector matched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const clientId = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
      const host = makeHost({ clientId, supportedOperations: ["hover"] });
      const requests = requestsFrom(yield* broker.connect(host, SERVER_BROWSER));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId,
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationInvalidSelectorError",
            message: "strict mode violation: locator('.row') resolved to 2 elements:",
            detail: { matchCount: 2 },
          },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const error = yield* broker
        .invoke<void>({ scope, operation: "hover", input: { locator: ".row" } })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PreviewAutomationInvalidSelectorError", matchCount: 2 });
      expect(error.message).toContain("matches 2 elements");
    }),
  ),
);

it.effect("keeps a selector that matched nothing apart from an invalid one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const clientId = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
      const host = makeHost({ clientId, supportedOperations: ["type"] });
      const requests = requestsFrom(yield* broker.connect(host, SERVER_BROWSER));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId,
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationInvalidSelectorError",
            message: "No element matches the selector.",
            detail: { matchCount: 0, beforeInput: true },
          },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const error = yield* broker
        .invoke<void>({ scope, operation: "type", input: { locator: "input[name=q]", text: "x" } })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PreviewAutomationInvalidSelectorError", matchCount: 0 });
      expect(error.message).toContain("matches no element");
    }),
  ),
);

it.effect("names the tab an open made whose page never connected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const clientId = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
      const requests = requestsFrom(yield* broker.connect(makeHost({ clientId }), SERVER_BROWSER));
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          clientId,
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationExecutionError",
            message:
              "The page did not load (ERR_CONNECTION_REFUSED); its new tab t1 is still open.",
            detail: { openedTabId: "t1", loadError: "ERR_CONNECTION_REFUSED" },
          },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const error = yield* broker
        .invoke<void>({ scope, operation: "open", input: {} })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        unloadedTab: { tabId: "t1", loadError: "ERR_CONNECTION_REFUSED" },
      });
      expect(error).not.toHaveProperty("dispatched");
    }),
  ),
);
