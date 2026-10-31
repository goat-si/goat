// @effect-diagnostics nodeBuiltinImport:off - the uploaded file is a real file on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as PreviewUpload from "./PreviewUpload.ts";
import { testActionChannel, testActionGate } from "./actionChannel.testkit.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

const FRAMED =
  '<input id="g" type="file"><input id="h" type="file"><input id="i" type="file"><script>window.changes = 0; g.addEventListener("change", () => changes++); h.addEventListener("change", () => changes++)</script>';

describe.skipIf(!chromiumInstalled)("agent uploads into framed file inputs", () => {
  let browser: Browser;

  beforeAll(async () => {
    // Site isolation as the desktop's tabs have it: a cross-site frame runs in its own process.
    browser = await chromium.launch({
      headless: true,
      args: ["--site-per-process"],
      ignoreDefaultArgs: ["--disable-site-isolation-trials"],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("uploads into framed inputs when allowed and refuses after Stop or a blocked fence", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-upload-"));
    using _removeDirectory = {
      [Symbol.dispose]: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
    };
    const file = NodePath.join(directory, "note.txt");
    NodeFS.writeFileSync(file, "hello");
    const context = await browser.newContext();
    await using _context = { [Symbol.asyncDispose]: () => context.close() };
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.route("https://outer.test/inner", (route) =>
      route.fulfill({ contentType: "text/html", body: FRAMED }),
    );
    await page.route("https://frame.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: FRAMED }),
    );
    // A same-site child inside the cross-site frame shares that frame's process, not the page's.
    await page.route("https://frame.test/host", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<iframe src="https://frame.test/child"></iframe>',
      }),
    );
    await page.route("https://outer.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<iframe id="same" src="https://outer.test/inner"></iframe><iframe id="cross" src="https://frame.test/"></iframe><iframe id="nested" src="https://frame.test/host"></iframe>',
      }),
    );
    await page.goto("https://outer.test/");
    const enter = " >> internal:control=enter-frame >> ";
    const cases = [
      { path: `#same${enter}`, inside: page.frameLocator("#same"), ownSession: false },
      { path: `#cross${enter}`, inside: page.frameLocator("#cross"), ownSession: true },
      {
        path: `#nested${enter}iframe${enter}`,
        inside: page.frameLocator("#nested").frameLocator("iframe"),
        ownSession: false,
      },
    ];
    for (const { path, inside, ownSession } of cases) {
      await inside.locator("#h").waitFor({ state: "attached" });
      const owner = await (await inside.locator("#h").elementHandle())!.ownerFrame();
      // The frames take every path: the page's session, a frame's own, and an ancestor frame's.
      expect(
        await context.newCDPSession(owner!).then(
          (session) => session.detach().then(() => true),
          () => false,
        ),
      ).toBe(ownSession);
      await PreviewUpload.setInputFiles(
        page,
        cdp,
        { locator: `${path}#g`, paths: [file] },
        testActionGate(page, cdp),
      );
      const state = (id: string) =>
        inside
          .locator(id)
          .evaluate((input) => [
            (input as unknown as { files: ArrayLike<{ name: string }> }).files[0]?.name ?? null,
            (globalThis as unknown as { changes: number }).changes,
          ]);
      expect(await state("#g")).toEqual(["note.txt", 1]);
      await expect(
        PreviewUpload.setInputFiles(
          page,
          cdp,
          { locator: `${path}#h`, paths: [file] },
          Object.assign(
            () => {
              throw new Error("stopped");
            },
            { channel: testActionChannel(page, cdp) },
          ),
        ),
      ).rejects.toThrow("stopped");
      expect(await state("#h")).toEqual([null, 1]);
      await expect(
        PreviewUpload.setInputFiles(
          page,
          cdp,
          { locator: `${path}#i`, paths: [file] },
          testActionGate(page, cdp, () => {
            throw new BrowserControlInterrupted("Blocked host", "blocked_url");
          }),
        ),
      ).rejects.toMatchObject({ reason: "blocked_url" });
      expect(await state("#i")).toEqual([null, 1]);
    }
  });
});
