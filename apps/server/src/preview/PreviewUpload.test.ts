// @effect-diagnostics nodeBuiltinImport:off - the uploaded file is a real file on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as PreviewUpload from "./PreviewUpload.ts";

const FRAMED =
  '<input id="g" type="file"><input id="h" type="file"><script>window.changes = 0; g.addEventListener("change", () => changes++); h.addEventListener("change", () => changes++)</script>';

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

  it("uploads into a same-site or out-of-process frame's input in one call after the gate, and never after Stop", async () => {
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
    await page.route("https://outer.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<iframe id="same" src="https://outer.test/inner"></iframe><iframe id="cross" src="https://frame.test/"></iframe>',
      }),
    );
    await page.goto("https://outer.test/");
    for (const frame of ["#same", "#cross"]) {
      const inside = page.frameLocator(frame);
      await inside.locator("#h").waitFor({ state: "attached" });
      const owner = await (await page.locator(frame).elementHandle())!.contentFrame();
      const ownSession = await context.newCDPSession(owner!).then(
        (session) => session.detach().then(() => true),
        () => false,
      );
      // The frames take both paths: the page's own session, and the frame's separate one.
      expect(ownSession).toBe(frame === "#cross");
      let gates = 0;
      await PreviewUpload.setInputFiles(
        page,
        cdp,
        { locator: `${frame} >> internal:control=enter-frame >> #g`, paths: [file] },
        () => {
          gates++;
        },
      );
      expect(gates).toBe(1);
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
          { locator: `${frame} >> internal:control=enter-frame >> #h`, paths: [file] },
          () => {
            throw new Error("stopped");
          },
        ),
      ).rejects.toThrow("stopped");
      expect(await state("#h")).toEqual([null, 1]);
    }
  });
});
