import { it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SecretFill from "./ServerBrowserSecretFill.ts";
import { SessionControl } from "./SessionControl.ts";

it.live("inspects the focused field in an isolated browser world", () =>
  Effect.gen(function* () {
    const fill = yield* SecretFill.make;
    yield* Effect.promise(async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await (await browser.newContext()).newPage();
        const cdp = await page.context().newCDPSession(page);
        const tab = {
          page,
          cdp,
          frameSessions: new Map(),
          control: new SessionControl("agent"),
          recording: null,
          recordingStart: null,
        };
        const thread = ThreadId.make("thread:history-field");
        await page.setContent(
          '<input id="normal" type="text"><input id="password" type="password"><input id="otp" autocomplete="one-time-code"><input id="card" autocomplete="cc-number"><textarea id="area"></textarea><div id="editable" contenteditable="true"></div>',
        );
        await page.locator("#normal").focus();
        expect(await fill.historyField(tab, thread)).toBeDefined();
        await page.evaluate(() =>
          Object.defineProperty(HTMLInputElement.prototype, "type", {
            configurable: true,
            get: () => "text",
          }),
        );
        await page.locator("#password").focus();
        expect(await fill.historyField(tab, thread)).toBeUndefined();
        await page.locator("#otp").focus();
        expect(await fill.historyField(tab, thread)).toBeUndefined();
        await page.locator("#card").focus();
        expect(await fill.historyField(tab, thread)).toBeUndefined();
        await page.locator("#area").focus();
        expect(await fill.historyField(tab, thread)).toBeDefined();
        await page.locator("#editable").focus();
        expect(await fill.historyField(tab, thread)).toBeDefined();
      } finally {
        await browser.close();
      }
    });
  }).pipe(Effect.provide(Layer.mock(SecretRequests.SecretRequests)({}))),
);
