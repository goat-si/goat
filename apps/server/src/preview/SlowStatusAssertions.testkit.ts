import { type PreviewAutomationStatus, type PreviewTabId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, vi } from "vite-plus/test";
import type * as Broker from "../mcp/PreviewAutomationBroker.ts";

type Fixture = typeof import("./ServerBrowser.test.ts");
export const assertSlowStatus = (
  broker: Broker.PreviewAutomationBroker["Service"],
  scope: Fixture["scope"],
  tabId: PreviewTabId,
  page: ReturnType<Fixture["makeContext"]>["page"],
) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.goto("https://example.com/"));
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<string>();
    page.title.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    yield* Effect.gen(function* () {
      const status = yield* broker
        .invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.promise(() => started.promise);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(250));
      expect((yield* Fiber.join(status)).title).toBeNull();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pending.resolve("late");
          vi.useRealTimers();
        }),
      ),
    );
  });
