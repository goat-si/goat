import { it } from "@effect/vitest";
import {
  SecretRef,
  SecretRequestError,
  ThreadId,
  type PreviewAutomationRequest,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerBrowserSecretFill from "./ServerBrowserSecretFill.ts";
import { SessionControl } from "./SessionControl.ts";

const threadId = ThreadId.make("card-operation-thread");
const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
const record = <T, A>(_tab: T, _action: string, run: () => Promise<A>) => run();
const blocked = Object.assign(async () => {}, { isFenced: () => false, blockedFrame: () => false });
const request = {
  requestId: "card",
  threadId,
  operation: "fillSecret",
  input: { secretRef: ref },
  timeoutMs: 15_000,
  agentSessionId: "agent-a",
} satisfies PreviewAutomationRequest;

it.live("consumes a partially filled card and guards evaluation and screenshots", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let available = true;
      const secrets = Layer.mock(SecretRequests.SecretRequests)({
        useCard: (input, use) => {
          if (!available || input.threadId !== threadId)
            return Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }));
          if (input.origin !== "https://card.test")
            return Effect.fail(new SecretRequestError({ reason: "origin_mismatch" }));
          available = false;
          return use({
            number: "4242424242424242",
            expiryMonth: "01",
            expiryYear: "2029",
            cvc: "003",
            name: "Example",
          }).pipe(
            Effect.tap((delivery) =>
              Effect.sync(() => {
                if (delivery === "none") available = true;
              }),
            ),
          );
        },
      });
      const fill = yield* ServerBrowserSecretFill.make.pipe(Effect.provide(secrets));
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (instance) => Effect.promise(() => instance.close()),
      );
      const page = yield* Effect.promise(async () => {
        const context = await browser.newContext();
        await context.route("**/*", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<form><input id="number" autocomplete="cc-number"><input id="cvc" autocomplete="cc-csc"></form>',
          }),
        );
        const page = await context.newPage();
        await page.goto("https://card.test/");
        await page.locator("#number").focus();
        await page.evaluate(
          'document.querySelector("#number").addEventListener("input", () => document.querySelector("#cvc").remove(), { once: true })',
        );
        return page;
      });
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const tab = {
        page,
        cdp,
        frameSessions: new Map(),
        control: new SessionControl("agent-a"),
        recording: null,
        recordingStart: null,
      };
      const result = yield* Effect.promise(() =>
        fill.fillCard(tab, request, Number.POSITIVE_INFINITY, record, blocked),
      );
      expect(result).toMatchObject({
        numberFilled: true,
        cvcFilled: false,
        verdict: "unverifiable",
        code: "form_changed",
      });
      expect(available).toBe(false);
      expect(
        yield* Effect.promise(() =>
          fill.guard(tab, { ...request, operation: "evaluate" }).then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
      expect(
        yield* Effect.promise(() =>
          fill
            .guard(tab, { ...request, operation: "snapshot", input: { captureImage: true } })
            .then(
              () => false,
              () => true,
            ),
        ),
      ).toBe(true);
    }),
  ),
);

it.live("an origin change between fields reports partial delivery and consumes the card", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let available = true;
      const secrets = Layer.mock(SecretRequests.SecretRequests)({
        useCard: (_input, use) => {
          if (!available) return Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }));
          available = false;
          return use({
            number: "4242424242424242",
            expiryMonth: "01",
            expiryYear: "2029",
            cvc: "003",
            name: "Example",
          }).pipe(
            Effect.tap((delivery) =>
              Effect.sync(() => {
                if (delivery === "none") available = true;
              }),
            ),
          );
        },
      });
      const fill = yield* ServerBrowserSecretFill.make.pipe(Effect.provide(secrets));
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (instance) => Effect.promise(() => instance.close()),
      );
      const page = yield* Effect.promise(async () => {
        const context = await browser.newContext();
        await context.route("**/*", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<form><input id="number" autocomplete="cc-number"><input id="cvc" autocomplete="cc-csc"></form>',
          }),
        );
        const page = await context.newPage();
        await page.goto("https://card.test/");
        await page.locator("#number").focus();
        return page;
      });
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const entered = yield* Deferred.make<void>();
      const resume = Promise.withResolvers<void>();
      const pausedCdp = new Proxy(cdp, {
        get(target, key) {
          if (key === "send")
            return async (
              method: string,
              params: { functionDeclaration?: string; arguments?: Array<{ value: unknown }> },
            ) => {
              const result = await Reflect.apply(target.send, target, [method, params]);
              if (
                method === "Runtime.callFunctionOn" &&
                params.functionDeclaration?.includes("GOAT_CARD_MUTATE") &&
                params.arguments?.[0]?.value === "number"
              ) {
                Deferred.doneUnsafe(entered, Effect.void);
                await resume.promise;
              }
              return result;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const tab = {
        page,
        cdp: pausedCdp,
        frameSessions: new Map(),
        control: new SessionControl("agent-a"),
        recording: null,
        recordingStart: null,
      };
      const attempt = yield* Effect.promise(() =>
        fill.fillCard(tab, request, Number.POSITIVE_INFINITY, record, blocked),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Effect.promise(() => page.goto("https://other.test/"));
      resume.resolve();
      const result = yield* Fiber.join(attempt);
      expect(result).toMatchObject({
        numberFilled: true,
        cvcFilled: false,
        verdict: "unverifiable",
        code: "form_changed",
      });
      expect(available).toBe(false);
    }),
  ),
);
