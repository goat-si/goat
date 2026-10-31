import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, type PreviewAutomationRequest } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import { makeBlockedTabFence } from "./blockedTabFence.ts";
import { withCaptureLock } from "./CaptureLock.ts";
import { withRefAnnotations } from "./annotateRefs.ts";
import { tabActionGate } from "./tabActionGate.ts";
import { SessionControl } from "./SessionControl.ts";

const layer = Layer.mergeAll(PreviewAgentActivity.layer, ServerSettings.layerTest()).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-run-end-cut-" })),
  Layer.provideMerge(NodeServices.layer),
);
const request = (threadId: ThreadId) =>
  ({
    threadId,
    tabId: "tab",
    operation: "snapshot",
    input: {},
    timeoutMs: 5000,
    runId: "run",
    agentSessionId: "agent",
    requestId: "request",
  }) as PreviewAutomationRequest;

it.effect(
  "a person-controlled snapshot stays cut after blocked visit, run end and capture-lock release",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Effect.acquireRelease(
          Effect.promise(() => chromium.launch({ headless: true })),
          (b) => Effect.promise(() => b.close()),
        );
        const page = yield* Effect.promise(() => browser.newPage());
        yield* Effect.promise(() =>
          page.route("https://*.test/**", (route) =>
            route.fulfill({ body: "<button>safe</button>", contentType: "text/html" }),
          ),
        );
        yield* Effect.promise(() => page.goto("https://safe.test/"));
        const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
        const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ blockedBrowserHosts: ["blocked.test"] });
        const fence = yield* makeBlockedTabFence();
        const threadId = ThreadId.make("observer-run-end");
        const end = yield* activity.begin(threadId, "run");
        const control = new SessionControl("agent");
        yield* Effect.promise(() => control.take("person"));
        const tab = {
          threadId,
          tabId: "tab",
          page,
          cdp,
          control,
          closing: false,
          desktop: null,
          viewers: new Set<never>(),
        };
        const signal = (yield* Effect.sync(() => new AbortController())).signal;
        const gate = tabActionGate(
          tab,
          request(threadId),
          fence,
          Infinity,
          signal,
          undefined,
          true,
        );
        const lock = Promise.withResolvers<void>();
        const holder = { captureLock: lock.promise, closing: false };
        const evaluate = vi.spyOn(page, "evaluate");
        const work = control.observe(() =>
          withCaptureLock(holder, () =>
            withRefAnnotations(
              page,
              "- button [ref=e1] [box=1,1,10,10]",
              async () => "captured",
              gate.channel,
            ),
          ),
        );
        void work.catch(() => undefined);
        yield* Effect.promise(() => page.goto("https://blocked.test/"));
        yield* Effect.promise(() => fence.observe(tab, "https://blocked.test/")!);
        yield* Effect.promise(() => page.goto("https://safe.test/"));
        yield* end;
        expect(fence.isFenced(tab, "run")).toBe(false);
        const nextEnd = yield* activity.begin(threadId, "run");
        expect(gate.signal?.aborted).toBe(true);
        expect(fence.signal(tab, "run")?.aborted).toBe(false);
        lock.resolve();
        const result = yield* Effect.promise(() =>
          work.then(
            () => null,
            (cause: unknown) => cause,
          ),
        );
        expect(result).toMatchObject({ reason: "blocked_url" });
        expect(
          evaluate.mock.calls.filter(([script]) => String(script).includes("goat-ref-overlay")),
        ).toEqual([]);
        yield* nextEnd;
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a blocked visit cuts a waiting observer from an earlier concurrent run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (b) => Effect.promise(() => b.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.route("https://*.test/**", (route) =>
          route.fulfill({ body: "<button>safe</button>", contentType: "text/html" }),
        ),
      );
      yield* Effect.promise(() => page.goto("https://safe.test/"));
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["blocked.test"] });
      const fence = yield* makeBlockedTabFence();
      const threadId = ThreadId.make("concurrent-observer-runs");
      const endFirst = yield* activity.begin(threadId, "run");
      const control = new SessionControl("agent");
      yield* Effect.promise(() => control.take("person"));
      const tab = {
        threadId,
        tabId: "tab",
        page,
        cdp,
        control,
        closing: false,
        desktop: null,
        viewers: new Set<never>(),
      };
      const signal = (yield* Effect.sync(() => new AbortController())).signal;
      const gate = tabActionGate(tab, request(threadId), fence, Infinity, signal, undefined, true);
      const release = yield* Deferred.make<void>();
      const lock = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(release).pipe(Effect.tap(() => Effect.sync(lock.resolve))),
      );
      const evaluate = vi.spyOn(page, "evaluate");
      const work = control.observe(() =>
        withCaptureLock({ captureLock: lock.promise, closing: false }, () =>
          withRefAnnotations(
            page,
            "- button [ref=e1] [box=1,1,10,10]",
            async () => "captured",
            gate.channel,
          ),
        ),
      );
      void work.catch(() => undefined);
      const endSecond = yield* activity.begin(threadId, "run-b");
      yield* Effect.promise(() => page.goto("https://blocked.test/"));
      yield* Effect.promise(() => fence.observe(tab, "https://blocked.test/")!);
      yield* Effect.promise(() => page.goto("https://safe.test/"));
      yield* Deferred.succeed(release, undefined);
      const result = yield* Effect.promise(() =>
        work.then(
          () => null,
          (cause: unknown) => cause,
        ),
      );
      expect(result).toMatchObject({ reason: "blocked_url" });
      expect(
        evaluate.mock.calls.filter(([script]) => String(script).includes("goat-ref-overlay")),
      ).toEqual([]);
      expect(fence.isFenced(tab, "run")).toBe(true);
      expect(fence.isFenced(tab, "run-b")).toBe(true);
      yield* endFirst;
      yield* endSecond;
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("an agent action cannot dispatch after its run ends while it waits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (b) => Effect.promise(() => b.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const fence = yield* makeBlockedTabFence();
      const threadId = ThreadId.make("agent-run-end");
      const end = yield* activity.begin(threadId, "run");
      const control = new SessionControl("agent");
      const tab = {
        threadId,
        tabId: "tab",
        page,
        cdp,
        control,
        closing: false,
        desktop: null,
        viewers: new Set<never>(),
      };
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const send = vi.spyOn(cdp, "send");
      const action = control.agent("agent", async (signal) => {
        const gate = tabActionGate(tab, request(threadId), fence, Infinity, signal);
        Deferred.doneUnsafe(entered, Effect.void);
        await latch.promise;
        await gate.channel.send("Runtime.evaluate", { expression: "globalThis.afterRun=true" });
      });
      void action.catch(() => undefined);
      yield* Deferred.await(entered);
      yield* end;
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Effect.promise(() =>
        action.then(
          () => null,
          (cause: unknown) => cause,
        ),
      );
      expect(result).toBeInstanceOf(Error);
      expect(send).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);
