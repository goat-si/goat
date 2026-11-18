import { ThreadId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import { makeCapacity } from "./ServerBrowserCapacity.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("reclaims the oldest idle hidden tab while protecting active and visible tabs", () =>
  Effect.gen(function* () {
    const tabs = new Map(
      Array.from({ length: 32 }, (_, index) => [
        String(index),
        {
          threadId: ThreadId.make(`thread-${index}`),
          tabId: String(index),
          control: new SessionControl(`agent-${Math.floor(index / 8)}`),
          viewers: new Set<string>(),
          desktop: {},
          recording: null,
          agentOperating: false,
          closing: false,
          usedAt: index,
        },
      ]),
    );
    const removed: string[] = [];
    tabs.get("2")?.control.stopAgents();
    const capacity = makeCapacity({
      tabs,
      pending: new Map(),
      isShown: (tab) => tab.tabId === "1",
      now: () => 31 * 60 * 1000,
      isActive: (thread) => Effect.succeed(thread === "thread-0"),
      drop: (tab) =>
        Effect.sync(() => {
          removed.push(tab.tabId);
          tabs.delete(tab.tabId);
        }),
    });
    yield* capacity.reclaim("agent-0");
    expect(removed).toEqual([]);
    yield* capacity.reclaim("new-agent");
    expect(removed).toEqual(["3"]);
    expect(capacity.atLimit("new-agent")).toBe(false);
  }),
);

it.effect("does not reclaim a hidden tab while an agent operation is queued or running", () =>
  Effect.gen(function* () {
    const gate = Promise.withResolvers<void>();
    const control = new SessionControl("owner");
    const action = control.agent("owner", () => gate.promise);
    const candidate = {
      threadId: ThreadId.make("busy"),
      tabId: "busy",
      control,
      viewers: new Set<string>(),
      desktop: {},
      recording: null,
      agentOperating: false,
      closing: false,
      usedAt: 0,
    };
    const tabs = new Map(
      Array.from({ length: 32 }, (_, index) => [
        String(index),
        index === 0
          ? candidate
          : { ...candidate, tabId: String(index), viewers: new Set(["viewer"]) },
      ]),
    );
    const removed: string[] = [];
    const capacity = makeCapacity({
      tabs,
      pending: new Map(),
      now: () => 31 * 60 * 1000,
      isShown: () => false,
      isActive: () => Effect.succeed(false),
      drop: (tab) =>
        Effect.sync(() => {
          removed.push(tab.tabId);
        }),
    });
    yield* capacity.reclaim("other");
    expect(removed).toEqual([]);
    gate.resolve();
    yield* Effect.promise(() => action);
    yield* capacity.reclaim("other");
    expect(removed).toEqual(["busy"]);
  }),
);

it.effect("retains an idle desktop slot until its page finishes unloading", () =>
  Effect.gen(function* () {
    const closing = yield* Deferred.make<void>();
    const unloaded = yield* Deferred.make<void>();
    const tabs = new Map(
      Array.from({ length: 32 }, (_, index) => [
        String(index),
        {
          threadId: ThreadId.make(`thread-${index}`),
          tabId: String(index),
          control: new SessionControl("other"),
          viewers: index === 0 ? new Set<string>() : new Set(["visible"]),
          desktop: {},
          recording: null,
          agentOperating: false,
          closing: false,
          usedAt: 0,
        },
      ]),
    );
    const capacity = makeCapacity({
      tabs,
      pending: new Map(),
      now: () => 31 * 60 * 1000,
      isShown: () => false,
      isActive: () => Effect.succeed(false),
      drop: (tab) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(closing, undefined);
          yield* Deferred.await(unloaded);
          tabs.delete(tab.tabId);
        }),
    });

    const reclaim = yield* capacity.reclaim("new-agent").pipe(Effect.forkChild);
    expect(
      yield* Effect.raceFirst(
        Deferred.await(closing).pipe(Effect.as(true)),
        Fiber.await(reclaim).pipe(Effect.as(false)),
      ),
    ).toBe(true);
    expect(capacity.atLimit("new-agent")).toBe(true);
    yield* Deferred.succeed(unloaded, undefined);
    yield* Fiber.join(reclaim);
    expect(capacity.atLimit("new-agent")).toBe(false);
  }),
);
