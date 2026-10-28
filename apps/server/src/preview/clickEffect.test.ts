import { chromium, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { aimClick, watchClick } from "./clickEffect.ts";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const fixture = async (run: (page: Page) => Promise<void>) => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    await run(await (await browser.newContext()).newPage());
  } finally {
    await browser.close();
  }
};

/** A page whose script reads never answer or always fail, as a dialog or a crashed renderer. */
const fakePage = (
  evaluateHandle: () => Promise<unknown>,
  url = { current: "https://page.test/" },
) => {
  const frame = { evaluateHandle };
  return {
    url: () => url.current,
    on: () => undefined,
    off: () => undefined,
    mainFrame: () => frame,
    evaluateHandle,
  } as unknown as Page;
};

it("does not confirm a click on inert content while the page ticks and polls", () =>
  fixture(async (page) => {
    await page.route("https://poll.test/**", (route) => route.fulfill({ body: "{}" }));
    await page.setContent(
      `<p id="still">static</p><span id="clock"></span><script>
        setInterval(() => { clock.textContent = String(Date.now()); fetch("https://poll.test/x").catch(() => {}); }, 5);
      </script>`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#still" })).resolves.toMatchObject({
      effect: "suspected_noop",
      evidence: [],
    });
  }));

it("does not count a failed page read as a navigation", async () => {
  const handle = {
    evaluate: async () => Promise.reject(new Error("Target crashed")),
    dispose: async () => undefined,
  };
  const watch = await watchClick(fakePage(async () => handle));
  await watch.arm({ point: { x: 1, y: 1 } });
  await expect(watch.settle()).resolves.toEqual({ effect: "suspected_noop", evidence: [] });
});

it("stops waiting for a watch that a dialog holds, and still answers", async () => {
  const watch = await watchClick(fakePage(() => new Promise(() => undefined)));
  await watch.arm({ point: { x: 1, y: 1 } });
  await expect(watch.settle()).resolves.toEqual({ effect: "suspected_noop", evidence: [] });
});

it("does not count a URL change from before the click was armed", async () => {
  const url = { current: "https://page.test/" };
  const watch = await watchClick(fakePage(async () => Promise.reject(new Error("no script")), url));
  url.current = "https://page.test/#route";
  await watch.arm({ point: { x: 1, y: 1 } });
  await expect(watch.settle()).resolves.toEqual({ effect: "suspected_noop", evidence: [] });
});

it("stops a watch that installed after the click stopped waiting for it", async () => {
  const late = Promise.withResolvers<unknown>();
  const stopped = Promise.withResolvers<void>();
  const watch = await watchClick(fakePage(() => late.promise));
  await watch.arm({ point: { x: 1, y: 1 } });
  await watch.settle();
  late.resolve({
    evaluate: async () => stopped.resolve(),
    dispose: async () => undefined,
  });
  await stopped.promise;
});

it("sees what a click changes inside an iframe, by locator and by point", () =>
  fixture(async (page) => {
    await page.setContent(
      `<iframe style="position:absolute;left:40px;top:40px;width:300px;height:200px;border:0" srcdoc="<button id=b onclick=&quot;this.textContent='saved'&quot; style='position:absolute;left:10px;top:10px'>save</button>"></iframe>`,
    );
    const button = page.frameLocator("iframe").locator("#b");
    await button.waitFor();
    await expect(
      ServerBrowserPage.click(page, { selector: "iframe >> internal:control=enter-frame >> #b" }),
    ).resolves.toMatchObject({ effect: "confirmed", evidence: expect.arrayContaining(["dom"]) });
    const box = (await button.boundingBox())!;
    await expect(
      ServerBrowserPage.click(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }),
    ).resolves.toMatchObject({ effect: "confirmed", evidence: expect.arrayContaining(["dom"]) });
  }));

it("does not confirm an inert click while a feed inserts rows elsewhere, and does confirm one that opens a menu", () =>
  fixture(async (page) => {
    await page.setContent(
      `<p id="still">static</p><button id="menu" onclick="document.body.append(Object.assign(document.createElement('div'), { textContent: 'menu' }))">open</button><ul id="feed"></ul><script>
        setInterval(() => feed.append(document.createElement("li")), 5);
      </script>`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#still" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
    await expect(ServerBrowserPage.click(page, { selector: "#menu" })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["dom"]),
    });
  }));

it("aims a point click inside a bordered, padded iframe at the control under the point", () =>
  fixture(async (page) => {
    // The border and padding put the content 42px in: a translation that ignores them lands on #a.
    await page.setContent(
      `<iframe style="position:absolute;left:40px;top:40px;width:300px;height:200px;border:30px solid #888;padding:12px" srcdoc="<span id=b onclick=&quot;this.firstChild.data='saved'&quot; style='position:absolute;left:30px;top:30px;width:20px;height:20px'>save</span><span id=a style='position:absolute;left:72px;top:72px;width:20px;height:20px'>a</span>"></iframe>`,
    );
    const target = page.frameLocator("iframe").locator("#b");
    await target.waitFor();
    const box = (await target.boundingBox())!;
    await expect(
      ServerBrowserPage.click(page, { x: box.x + 5, y: box.y + 5 }),
    ).resolves.toMatchObject({ effect: "confirmed", evidence: expect.arrayContaining(["dom"]) });
    expect(await target.textContent()).toBe("saved");
  }));

it("stops aiming when the page cannot answer, so the click is not held", async () => {
  const page = fakePage(() => new Promise(() => undefined));
  await expect(aimClick(page, null, { x: 3, y: 4 })).resolves.toEqual({ point: { x: 3, y: 4 } });
});

it("does not confirm an inert click while banners land on its ancestor", () =>
  fixture(async (page) => {
    await page.setContent(
      `<p id="still">static</p><script>
        setInterval(() => document.body.append(document.createElement("aside")), 5);
      </script>`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#still" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
  }));

it("confirms a menu whose trigger stops propagation and renders it elsewhere", () =>
  fixture(async (page) => {
    await page.setContent(
      `<span id="trigger">open</span><div id="overlays"></div><script>
        trigger.addEventListener("click", (event) => {
          event.stopPropagation();
          queueMicrotask(() => overlays.append(document.createElement("menu")));
        });
      </script>`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#trigger" })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["dom"]),
    });
  }));

it("sends nothing when a dialog opened before the press, and does not call it the click's", () =>
  fixture(async (page) => {
    page.on("dialog", (dialog) => void dialog.dismiss());
    await page.setContent(
      `<button id="b" style="position:absolute;left:10px;top:10px" onclick="window.clicked = true">go</button><script>
        document.elementFromPoint = () => { alert("unrelated"); return null; };
      </script>`,
    );
    await expect(ServerBrowserPage.click(page, { x: 20, y: 20 })).rejects.toMatchObject({
      reason: "dialogPending",
      beforeInput: true,
    });
    expect(await page.evaluate("window.clicked === true")).toBe(false);
  }));

it("does not credit a click with what timers change right after it", () =>
  fixture(async (page) => {
    await page.setContent(
      `<p id="still" style="position:absolute;left:10px;top:10px;margin:0">static</p><div id="feed" style="position:absolute;top:100px"></div><script>
        setInterval(() => feed.append(document.createElement("aside")), 1);
      </script>`,
    );
    // On the paragraph, and on the page's background beside it.
    for (const point of [
      { x: 20, y: 18 },
      { x: 400, y: 40 },
    ])
      for (let attempt = 0; attempt < 5; attempt++)
        await expect(ServerBrowserPage.click(page, point)).resolves.toMatchObject({
          effect: "suspected_noop",
        });
  }));

it("does not credit timers after a click a capture listener stopped", () =>
  fixture(async (page) => {
    await page.setContent(
      `<p id="still" style="position:absolute;left:10px;top:10px;margin:0">static</p><div id="feed" style="position:absolute;top:100px"></div><script>
        document.addEventListener("click", (event) => event.stopPropagation(), true);
        setInterval(() => feed.append(document.createElement("aside")), 1);
      </script>`,
    );
    for (let attempt = 0; attempt < 40; attempt++)
      await expect(ServerBrowserPage.click(page, { x: 20, y: 18 })).resolves.toMatchObject({
        effect: "suspected_noop",
      });
  }));

it("keeps crediting a click whose handler dispatches another click first", () =>
  fixture(async (page) => {
    await page.setContent(
      `<span id="outer">open</span><b id="inner"></b><div id="overlays"></div><script>
        outer.addEventListener("click", () => {
          inner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          overlays.append(document.createElement("menu"));
        });
      </script>`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#outer" })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["dom"]),
    });
  }));

it("sees a change inside an open shadow root", () =>
  fixture(async (page) => {
    await page.setContent(
      `<div id="host"></div><script>
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = "<span id=s>save</span>";
        root.getElementById("s").addEventListener("click", (event) => { event.target.firstChild.data = "saved"; });
      </script>`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#host >> #s" })).resolves.toMatchObject(
      {
        effect: "confirmed",
        evidence: expect.arrayContaining(["dom"]),
      },
    );
  }));
