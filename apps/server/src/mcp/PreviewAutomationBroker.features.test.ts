import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const scope = {
  environmentId: EnvironmentId.make("environment-features"),
  requestNamespace: "session-features",
  thread: {
    threadId: ThreadId.make("thread-features"),
    providerSessionId: "session-features",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

it.effect.each(["ordinary", "assigned", "exact", "serverOnly"] as const)(
  "%s routing refuses unsupported read and snapshot options without breaking plain snapshots",
  (route) =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));
        const ready = yield* Deferred.make<string>();
        const tabId = PreviewTabId.make("tab-features");
        const clientId = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
        const events = yield* broker.connect({ clientId, environmentId: scope.environmentId });
        yield* Stream.runForEach(events, (event) =>
          event.type === "connected"
            ? Deferred.succeed(ready, event.connectionId)
            : broker.respond({
                clientId,
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result: { tabId },
              }),
        ).pipe(Effect.forkScoped);
        const connectionId = yield* Deferred.await(ready);
        yield* broker.focusHost({
          clientId,
          connectionId,
          environmentId: scope.environmentId,
          focused: true,
          liveTabs: [{ threadId: scope.thread.threadId, tabId }],
        });
        if (route === "assigned") yield* broker.invoke({ scope, operation: "status", input: {} });
        const target =
          route === "exact"
            ? { exact: { browserInstanceId: clientId, connectionId, tabId } }
            : route === "serverOnly"
              ? { serverHostOnly: true }
              : {};
        for (const request of [
          { operation: "snapshot" as const, input: { scope: { selector: "main" } } },
          { operation: "snapshot" as const, input: { interactiveOnly: false } },
          { operation: "read" as const, input: {} },
        ]) {
          const result = yield* broker
            .invoke<void>({ scope, ...target, ...request, updateCurrentTab: route === "assigned" })
            .pipe(Effect.flip);
          expect(result._tag).toBe("PreviewAutomationNoAvailableHostError");
        }
        expect(
          yield* broker.invoke({ scope, ...target, operation: "snapshot", input: {} }),
        ).toEqual({ tabId });
      }),
    ),
);

it.effect.each(["ordinary", "assigned", "exact", "serverOnly"] as const)(
  "%s routing delivers read and snapshot options to a capable host",
  (route) =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));
        const ready = yield* Deferred.make<string>();
        const tabId = PreviewTabId.make("tab-capable");
        const clientId = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
        const events = yield* broker.connect({
          clientId,
          environmentId: scope.environmentId,
          supportedOperations: [...PREVIEW_AUTOMATION_SERVER_OPERATIONS],
          supportedFeatures: ["snapshotOptions"],
        });
        yield* Stream.runForEach(events, (event) =>
          event.type === "connected"
            ? Deferred.succeed(ready, event.connectionId)
            : broker.respond({
                clientId,
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result: { tabId, operation: event.request.operation, input: event.request.input },
              }),
        ).pipe(Effect.forkScoped);
        const connectionId = yield* Deferred.await(ready);
        yield* broker.focusHost({
          clientId,
          connectionId,
          environmentId: scope.environmentId,
          focused: true,
          liveTabs: [{ threadId: scope.thread.threadId, tabId }],
        });
        if (route === "assigned") yield* broker.invoke({ scope, operation: "status", input: {} });
        const target =
          route === "exact"
            ? { exact: { browserInstanceId: clientId, connectionId, tabId } }
            : route === "serverOnly"
              ? { serverHostOnly: true }
              : {};
        for (const operation of ["read", "snapshot"] as const) {
          expect(
            yield* broker.invoke({
              scope,
              ...target,
              operation,
              input: { scope: { selector: "main" } },
            }),
          ).toMatchObject({ operation, input: { scope: { selector: "main" } } });
        }
      }),
    ),
);

it.effect("carries a closed popup's opener from the host to the caller's error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));
      const ready = yield* Deferred.make<string>();
      const tabId = PreviewTabId.make("tab-popup");
      const clientId = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
      const events = yield* broker.connect({ clientId, environmentId: scope.environmentId });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Deferred.succeed(ready, event.connectionId)
          : broker.respond({
              clientId,
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationTabNotFoundError",
                message: "host text the broker does not forward",
                detail: { closedPopup: { openerTabId: "tab-opener", openerOpen: true } },
              },
            }),
      ).pipe(Effect.forkScoped);
      const connectionId = yield* Deferred.await(ready);
      yield* broker.focusHost({
        clientId,
        connectionId,
        environmentId: scope.environmentId,
        focused: true,
        liveTabs: [{ threadId: scope.thread.threadId, tabId }],
      });
      const error = yield* broker
        .invoke<void>({ scope, tabId, operation: "click", input: {} })
        .pipe(Effect.flip);
      expect(error.message).toBe(
        "Tab tab-popup, a popup, has closed. Its opener tab-opener is still open: pass tabId tab-opener to continue there.",
      );
    }),
  ),
);
