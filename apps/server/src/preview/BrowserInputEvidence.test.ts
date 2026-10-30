import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import { startBrowserInputEvidence } from "./BrowserInputEvidence.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

it.live("accepts trusted normal-field input and refuses password and focus-redirection input", () =>
  Effect.promise(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.setContent(
        '<input id="normal"><input id="password" type="password"><div id="editable" contenteditable="true"></div>',
      );
      await page.locator("#normal").focus();
      const normal = await startBrowserInputEvidence(page);
      await page.keyboard.insertText("hello");
      expect(await normal.finish()).toBe(true);
      await page.locator("#editable").focus();
      const editable = await startBrowserInputEvidence(page);
      await page.keyboard.insertText("hello");
      expect(await editable.finish()).toBe(true);
      await page.locator("#password").focus();
      const password = await startBrowserInputEvidence(page);
      await page.keyboard.insertText("secret");
      expect(await password.finish()).toBe(false);
      await page.evaluate(
        'document.querySelector("#normal").addEventListener("beforeinput", () => { document.querySelector("#password").focus(); }); document.querySelector("#password").addEventListener("input", () => { document.querySelector("#normal").focus(); })',
      );
      await page.locator("#normal").focus();
      const redirected = await startBrowserInputEvidence(page);
      await page.keyboard.insertText("redirected");
      expect(await page.locator("#password").inputValue()).toContain("redirected");
      expect(await redirected.finish()).toBe(false);
    } finally {
      await browser.close();
    }
  }),
);

it.live("fails closed when input evidence may be hidden or comes from a protected event", () =>
  Effect.promise(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.setContent('<input id="normal"><input id="password" type="password">');
      await page.evaluate(
        'document.querySelector("#normal").addEventListener("beforeinput", () => { document.querySelector("#password").dispatchEvent(new InputEvent("input", { bubbles: true, composed: true })); })',
      );
      await page.locator("#normal").focus();
      const forged = await startBrowserInputEvidence(page);
      await page.keyboard.insertText("hello");
      expect(await forged.finish()).toBe(false);
      await page.setContent('<input id="normal">');
      await page.locator("#normal").focus();
      await page.evaluate('window.addEventListener("input", () => {}, true)');
      const hidden = await startBrowserInputEvidence(page);
      await page.keyboard.insertText("again");
      expect(await hidden.finish()).toBe(false);
    } finally {
      await browser.close();
    }
  }),
);

it.live(
  "does not retain when navigation or a closed shadow target prevents complete observation",
  () =>
    Effect.promise(async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await (await browser.newContext()).newPage();
        await page.setContent('<input id="normal"><div id="host" contenteditable="true"></div>');
        await page.locator("#normal").focus();
        const navigated = await startBrowserInputEvidence(page);
        await page.goto("data:text/html,<p>next</p>");
        expect(await navigated.finish()).toBe(false);
        await page.setContent('<div id="host" contenteditable="true"></div>');
        await page.evaluate(
          'const host = document.querySelector("#host"); const root = host.attachShadow({mode:"closed"}); root.innerHTML = "<input type=password>"; root.querySelector("input").focus();',
        );
        const shadow = await startBrowserInputEvidence(page);
        await page.keyboard.insertText("secret");
        expect(await shadow.finish()).toBe(false);
      } finally {
        await browser.close();
      }
    }),
);

it.live(
  "observes the actual type dispatch even when focus returns after a password receives input",
  () =>
    Effect.promise(async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await (await browser.newContext()).newPage();
        await page.setContent(
          '<input id="normal"><input id="password" type="password"><script>normal.addEventListener("beforeinput", () => password.focus()); password.addEventListener("input", () => normal.focus());</script>',
        );
        let finish = async () => true;
        await ServerBrowserPage.type(page, { selector: "#normal", text: "hello" }, undefined, {
          onHistoryFocus: async () => {
            finish = (await startBrowserInputEvidence(page)).finish;
          },
        });
        expect(await page.locator("#password").inputValue()).toBe("hello");
        expect(await finish()).toBe(false);
      } finally {
        await browser.close();
      }
    }),
);

it.live("does not retain when another isolated world has an earlier capture listener", () =>
  Effect.promise(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      const cdp = await page.context().newCDPSession(page);
      await page.setContent('<input id="normal">');
      const tree = await cdp.send("Page.getFrameTree");
      const world = await cdp.send("Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id,
        worldName: "other-world",
      });
      await cdp.send("Runtime.evaluate", {
        expression: 'window.addEventListener("input", () => {}, true)',
        contextId: world.executionContextId,
      });
      await page.locator("#normal").focus();
      const evidence = await startBrowserInputEvidence(page);
      await page.keyboard.insertText("hello");
      expect(await evidence.finish()).toBe(false);
    } finally {
      await browser.close();
    }
  }),
);
