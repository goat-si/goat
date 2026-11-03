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

const threadId = ThreadId.make("login-operation-thread");
const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
const record = <T, A>(_tab: T, _action: string, run: () => Promise<A>) => run();
const blocked = Object.assign(async () => {}, { isFenced: () => false, blockedFrame: () => false });
const request = {
  requestId: "login",
  threadId,
  operation: "fillSecret",
  input: { secretRef: ref },
  timeoutMs: 15_000,
  agentSessionId: "agent-a",
} satisfies PreviewAutomationRequest;

it.live(
  "fills once and guards evaluation and screenshots while login fields hold their values",
  () => {
    const abortBeforeInput = new AbortController();
    return Effect.scoped(
      Effect.gen(function* () {
        let available = true;
        const secrets = Layer.mock(SecretRequests.SecretRequests)({
          useLogin: (input, use) => {
            if (!available || input.threadId !== threadId)
              return Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }));
            if (input.origin !== "https://login.test")
              return Effect.fail(new SecretRequestError({ reason: "origin_mismatch" }));
            available = false;
            return use({ username: "example-user", password: "example-password" }).pipe(
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
          (browser) => Effect.promise(() => browser.close()),
        );
        const page = yield* Effect.promise(async () => {
          const context = await browser.newContext();
          await context.route("**/*", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: '<form><input id="user" autocomplete="username"><input id="pw" type="password"></form>',
            }),
          );
          const page = await context.newPage();
          await page.goto("https://login.test/");
          await page.locator("#user").focus();
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
        let failInspection = true;
        const faultCdp = new Proxy(cdp, {
          get(target, key) {
            if (key === "send")
              return (method: string, params: { functionDeclaration?: string }) => {
                if (
                  failInspection &&
                  method === "Runtime.callFunctionOn" &&
                  params?.functionDeclaration?.includes("let focused = document.activeElement")
                ) {
                  failInspection = false;
                  return Promise.reject(new Error("inspection failed"));
                }
                return Reflect.apply(target.send, target, [method, params]);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const beforeInput = yield* Effect.promise(() =>
          fill
            .fillLogin(
              { ...tab, cdp: faultCdp },
              request,
              Number.POSITIVE_INFINITY,
              record,
              blocked,
            )
            .then(
              () => false,
              () => true,
            ),
        );
        expect(beforeInput).toBe(true);
        expect(available).toBe(true);
        expect(yield* Effect.promise(() => page.locator("#user").inputValue())).toBe("");
        let fenced = false;
        const fenceCdp = new Proxy(cdp, {
          get(target, key) {
            if (key === "send")
              return async (method: string, params: { functionDeclaration?: string }) => {
                const response = await Reflect.apply(target.send, target, [method, params]);
                if (
                  method === "Runtime.callFunctionOn" &&
                  params?.functionDeclaration === "function () { return this.password; }"
                )
                  fenced = true;
                return response;
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const fenceGate = Object.assign(async () => {}, {
          isFenced: () => fenced,
          blockedFrame: () => false,
        });
        const gateRefused = yield* Effect.promise(() =>
          fill
            .fillLogin(
              { ...tab, cdp: fenceCdp },
              request,
              Number.POSITIVE_INFINITY,
              record,
              fenceGate,
            )
            .then(
              () => false,
              () => true,
            ),
        );
        expect(gateRefused).toBe(true);
        expect(available).toBe(true);
        expect(yield* Effect.promise(() => page.locator("#user").inputValue())).toBe("");
        const inspectionEntered = yield* Deferred.make<void>();
        const inspectionDone = yield* Deferred.make<void>();
        const resumeInspection = Promise.withResolvers<void>();
        const waitingCdp = new Proxy(cdp, {
          get(target, key) {
            if (key === "send")
              return async (method: string, params: { functionDeclaration?: string }) => {
                if (
                  method === "Runtime.callFunctionOn" &&
                  params?.functionDeclaration?.includes("let focused = document.activeElement")
                ) {
                  Deferred.doneUnsafe(inspectionEntered, Effect.void);
                  await resumeInspection.promise;
                  try {
                    return await Reflect.apply(target.send, target, [method, params]);
                  } finally {
                    Deferred.doneUnsafe(inspectionDone, Effect.void);
                  }
                }
                return Reflect.apply(target.send, target, [method, params]);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const abortGate = Object.assign(async () => {}, {
          isFenced: () => false,
          blockedFrame: () => false,
          signal: abortBeforeInput.signal,
        });
        const abortAttempt = yield* Effect.promise(() =>
          fill
            .fillLogin(
              { ...tab, cdp: waitingCdp },
              request,
              Number.POSITIVE_INFINITY,
              record,
              abortGate,
            )
            .then(
              () => false,
              () => true,
            ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(inspectionEntered);
        abortBeforeInput.abort(new Error("stop before input"));
        expect(yield* Fiber.join(abortAttempt)).toBe(true);
        expect(available).toBe(true);
        resumeInspection.resolve();
        yield* Deferred.await(inspectionDone);
        const otherThread = yield* Effect.promise(() =>
          fill
            .fillLogin(
              tab,
              { ...request, threadId: ThreadId.make("other-thread") },
              Number.POSITIVE_INFINITY,
              record,
              blocked,
            )
            .then(
              () => false,
              () => true,
            ),
        );
        expect(otherThread).toBe(true);
        expect(available).toBe(true);
        yield* Effect.promise(() => page.goto("https://wrong.test/"));
        yield* Effect.promise(() => page.locator("#user").focus());
        const wrongOrigin = yield* Effect.promise(() =>
          fill.fillLogin(tab, request, Number.POSITIVE_INFINITY, record, blocked).then(
            () => false,
            () => true,
          ),
        );
        expect(wrongOrigin).toBe(true);
        expect(available).toBe(true);
        expect(yield* Effect.promise(() => page.locator("#user").inputValue())).toBe("");
        yield* Effect.promise(() => page.goto("https://login.test/"));
        yield* Effect.promise(() => page.locator("#user").focus());
        yield* Effect.promise(() =>
          page.evaluate(
            `(() => { const duplicate = document.createElement("input"); duplicate.type = "password"; document.querySelector("form").append(duplicate); })()`,
          ),
        );
        const refused = yield* Effect.promise(() =>
          fill.fillLogin(tab, request, Number.POSITIVE_INFINITY, record, blocked),
        );
        expect(refused).toMatchObject({
          usernameFilled: false,
          passwordFilled: false,
          verdict: "refused",
          code: "ambiguous_password",
        });
        expect(available).toBe(true);
        expect(yield* Effect.promise(() => page.locator("#user").inputValue())).toBe("");
        yield* Effect.promise(() => page.goto("https://login.test/"));
        yield* Effect.promise(() => page.locator("#user").focus());
        yield* Effect.promise(() =>
          page.evaluate(
            `document.querySelector("#user").addEventListener("input", () => document.querySelector("#pw").remove(), { once: true })`,
          ),
        );
        const partial = yield* Effect.promise(() =>
          fill.fillLogin(tab, request, Number.POSITIVE_INFINITY, record, blocked),
        );
        expect(partial).toEqual({
          usernameFilled: true,
          passwordFilled: false,
          verdict: "unverifiable",
        });
        expect(available).toBe(false);
        const partialRetry = yield* Effect.promise(() =>
          fill.fillLogin(tab, request, Number.POSITIVE_INFINITY, record, blocked).then(
            () => false,
            () => true,
          ),
        );
        expect(partialRetry).toBe(true);
        available = true;
        yield* Effect.promise(() => page.goto("https://login.test/"));
        yield* Effect.promise(() => page.locator("#user").focus());
        const result = yield* Effect.promise(() =>
          fill.fillLogin(tab, request, Number.POSITIVE_INFINITY, record, blocked),
        );
        expect(result).toEqual({
          usernameFilled: true,
          passwordFilled: true,
          verdict: "confirmed",
        });
        expect(available).toBe(false);
        const secondUse = yield* Effect.promise(() =>
          fill.fillLogin(tab, request, Number.POSITIVE_INFINITY, record, blocked).then(
            () => false,
            () => true,
          ),
        );
        expect(secondUse).toBe(true);
        expect(JSON.stringify(result)).not.toContain("example-");
        const masked = fill.maskText(threadId)("example-user example-password");
        expect(masked).not.toContain("example-user");
        expect(masked).not.toContain("example-password");
        const evaluation = yield* Effect.promise(() =>
          fill.guard(tab, { ...request, operation: "evaluate" }).then(
            () => false,
            () => true,
          ),
        );
        const screenshot = yield* Effect.promise(() =>
          fill
            .guard(tab, { ...request, operation: "snapshot", input: { captureImage: true } })
            .then(
              () => false,
              () => true,
            ),
        );
        expect(evaluation).toBe(true);
        expect(screenshot).toBe(true);
        available = true;
        yield* Effect.promise(() => page.goto("https://login.test/"));
        yield* Effect.promise(() => page.locator("#user").focus());
        const afterUserCdp = new Proxy(cdp, {
          get(target, key) {
            if (key === "send")
              return (
                method: string,
                params: { functionDeclaration?: string; arguments?: Array<{ value: unknown }> },
              ) => {
                if (
                  method === "Runtime.callFunctionOn" &&
                  params?.functionDeclaration?.includes("GOAT_LOGIN_MUTATE") &&
                  params.arguments?.[0]?.value === "password"
                )
                  return Promise.reject(new Error("password dispatch failed"));
                return Reflect.apply(target.send, target, [method, params]);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const afterInput = yield* Effect.promise(() =>
          fill
            .fillLogin(
              { ...tab, cdp: afterUserCdp },
              request,
              Number.POSITIVE_INFINITY,
              record,
              blocked,
            )
            .then(
              () => false,
              () => true,
            ),
        );
        expect(afterInput).toBe(true);
        expect(yield* Effect.promise(() => page.locator("#user").inputValue())).toBe(
          "example-user",
        );
        expect(available).toBe(false);
      }),
    );
  },
);
