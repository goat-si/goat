import { ThreadId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
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
    const capacity = makeCapacity({
      tabs,
      pending: new Map(),
      isShown: (tab) => tab.tabId === "1",
      now: () => 31 * 60 * 1000,
      isActive: (thread) => Effect.succeed(thread === "thread-0"),
      drop: (tab) => {
        removed.push(tab.tabId);
        tabs.delete(tab.tabId);
      },
    });
    yield* capacity.reclaim("agent-0");
    expect(removed).toEqual([]);
    yield* capacity.reclaim("new-agent");
    expect(removed).toEqual(["2"]);
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
      drop: (tab) => {
        removed.push(tab.tabId);
      },
    });
    yield* capacity.reclaim("other");
    expect(removed).toEqual([]);
    gate.resolve();
    yield* Effect.promise(() => action);
    yield* capacity.reclaim("other");
    expect(removed).toEqual(["busy"]);
  }),
);
