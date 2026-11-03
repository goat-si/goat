import { it } from "@effect/vitest";
import { SecretRef, ThreadId, type PreviewAutomationRequest } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import { makeCodeOperation } from "./ServerBrowserCodeOperation.ts";
import { SessionControl } from "./SessionControl.ts";

const threadId = ThreadId.make("code-operation-thread");
const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
const request = {
  requestId: "code",
  threadId,
  operation: "fillSecret",
  input: { secretRef: ref },
  timeoutMs: 15000,
  agentSessionId: "agent-a",
} satisfies PreviewAutomationRequest;
const record = <T, A>(_tab: T, _action: string, run: () => Promise<A>) => run();
const blocked = Object.assign(async () => {}, { isFenced: () => false, blockedFrame: () => false });

it.live("navigation before code dispatch refuses without using a fill", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (b) => Effect.promise(() => b.close()),
      );
      const page = yield* Effect.promise(async () => {
        const context = await browser.newContext();
        await context.route("**/*", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<form><input id="code" autocomplete="one-time-code"></form>',
          }),
        );
        const page = await context.newPage();
        await page.goto("https://code.test/");
        await page.locator("#code").focus();
        return page;
      });
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const entered = yield* Deferred.make<void>();
      const resume = Promise.withResolvers<void>();
      let paused = false;
      const cdpProxy = new Proxy(cdp, {
        get(target, key) {
          if (key === "send")
            return async (method: string, params: { functionDeclaration?: string }) => {
              const result = await Reflect.apply(target.send, target, [method, params]);
              if (!paused && params?.functionDeclaration === "function () { return this.field; }") {
                paused = true;
                Deferred.doneUnsafe(entered, Effect.void);
                await resume.promise;
              }
              return result;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      let fills = 0;
      const operation = makeCodeOperation({
        debugLogging: () => false,
        reserve: (_tab, run) => run(),
        recording: () => false,
        register: () => {},
        protect: () => () => {},
        use: async (_input, run) => {
          const result = await run("123456");
          if (result !== "none") fills++;
          return result;
        },
      });
      const tab = {
        page,
        cdp: cdpProxy,
        frameSessions: new Map(),
        control: new SessionControl("agent-a"),
        recording: null,
        recordingStart: null,
      };
      const attempt = yield* Effect.promise(() =>
        operation(tab, request, Number.POSITIVE_INFINITY, record, blocked),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Effect.promise(() => page.goto("https://other.test/"));
      resume.resolve();
      expect(yield* Fiber.join(attempt)).toMatchObject({ filled: false, verdict: "refused" });
      expect(fills).toBe(0);
      expect(yield* Effect.promise(() => page.locator("#code").inputValue())).toBe("");
    }),
  ),
);
