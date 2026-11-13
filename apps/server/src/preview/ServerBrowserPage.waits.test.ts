import { chromium, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { DownloadJournal } from "./downloadJournal.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { extraWaits } from "./waitExtras.ts";

const fixture = async (run: (page: Page) => Promise<void>) => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.route("https://app.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>app</p>" }),
    );
    await page.goto("https://app.test/start");
    await run(page);
  } finally {
    await browser.close();
  }
};

it("a URL glob wait holds once a same-document change reaches a matching URL", () =>
  fixture(async (page) => {
    const waiting = ServerBrowserPage.waitFor(page, { urlGlob: "**/done*" }).then(() => page.url());
    await page.evaluate("history.pushState({}, '', '/flow/done?step=3')");
    expect(await waiting).toBe("https://app.test/flow/done?step=3");
  }));

it("a URL glob wait on a URL that already matches holds at once, beside other conditions", () =>
  fixture(async (page) => {
    await expect(
      ServerBrowserPage.waitFor(page, { urlGlob: "https://app.test/*", text: "app" }),
    ).resolves.toEqual({});
  }));

it("a download wait whose last check fails leaves the download for the next wait", () =>
  fixture(async (page) => {
    const journal = new DownloadJournal();
    const file = {
      fileName: "report.csv",
      path: "/artifacts/report.csv",
      sizeBytes: 3,
      url: "https://app.test/report.csv",
      completedAt: "2026-11-13T00:00:00.000Z",
    };
    journal.started().saved(file);
    const downloads = { journal, since: 0, kept: () => true, claims: true };
    const moved = () => {
      throw new Error("the tab moved to another page during the wait");
    };
    await expect(
      ServerBrowserPage.waitFor(page, { download: true }, undefined, {
        ...downloads,
        confirm: moved,
      }),
    ).rejects.toThrow("the tab moved");
    await expect(
      ServerBrowserPage.waitFor(page, { download: true }, undefined, downloads),
    ).resolves.toEqual({
      download: file,
    });
  }));

it("a download wait that already ended takes nothing when its abandoned pass finishes", () =>
  fixture(async (page) => {
    const journal = new DownloadJournal();
    const file = {
      fileName: "late.csv",
      path: "/artifacts/late.csv",
      sizeBytes: 3,
      url: "https://app.test/late.csv",
      completedAt: "2026-11-13T00:00:00.000Z",
    };
    journal.started().saved(file);
    const downloads = { journal, since: 0, kept: () => true, claims: true };
    // The pass found the download, then the wait timed out before the pass called finish.
    const extras = extraWaits(page, { download: true }, downloads);
    await Promise.all(extras.pending(1_000));
    extras.end();
    expect(extras.finish()).toEqual({});
    await expect(
      ServerBrowserPage.waitFor(page, { download: true, timeoutMs: 1_000 }, undefined, downloads),
    ).resolves.toEqual({ download: file });
  }));
