import { it } from "@effect/vitest";
import {
  SecretRef,
  SecretRequestError,
  ThreadId,
  type PreviewAutomationRequest,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
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
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let available = true;
        const secrets = Layer.mock(SecretRequests.SecretRequests)({
          useLogin: (input, use) => {
            if (!available || input.threadId !== threadId)
              return Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }));
            if (input.origin !== "https://login.test")
              return Effect.fail(new SecretRequestError({ reason: "origin_mismatch" }));
            return use({ username: "example-user", password: "example-password" }).pipe(
              Effect.tap((complete) =>
                Effect.sync(() => {
                  if (complete) available = false;
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
        expect(available).toBe(true);
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
      }),
    ),
);
