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
      `<iframe style="position:absolute;left:40px;top:40px;width:300px;height:200px;border:0" srcdoc="<button id=b onclick=&quot;this.textContent = 'saved ' + (++window.n || (window.n = 1))&quot; style='position:absolute;left:10px;top:10px'>save</button>"></iframe>`,
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

it("does not credit a click with input another field receives meanwhile", () =>
  fixture(async (page) => {
    await page.setContent(
      `<p id="still" style="position:absolute;left:10px;top:10px;margin:0">static</p><input id="other" style="position:absolute;top:100px"><script>
        setInterval(() => { other.value += "x"; other.dispatchEvent(new Event("input", { bubbles: true })); }, 1);
      </script>`,
    );
    for (let attempt = 0; attempt < 10; attempt++)
      await expect(ServerBrowserPage.click(page, { x: 20, y: 18 })).resolves.toMatchObject({
        effect: "suspected_noop",
      });
  }));

it("credits what a window capture handler the page set earlier does for the click", () =>
  fixture(async (page) => {
    await page.setContent(
      `<span id="trigger">open</span><div id="overlays"></div><script>
        window.addEventListener("click", (event) => {
          if (event.target.id === "trigger") overlays.append(document.createElement("menu"));
        }, true);
      </script>`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#trigger" })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["dom"]),
    });
  }));

it("credits a menu opened by a right click or a double click", () =>
  fixture(async (page) => {
    await page.setContent(
      `<span id="right" oncontextmenu="event.preventDefault(); overlays.append(document.createElement('menu'))">right</span>
       <span id="double" ondblclick="overlays.append(document.createElement('menu'))">double</span><div id="overlays"></div>`,
    );
    await expect(
      ServerBrowserPage.click(page, { selector: "#right", button: "right" }),
    ).resolves.toMatchObject({ effect: "confirmed", evidence: expect.arrayContaining(["dom"]) });
    await expect(
      ServerBrowserPage.click(page, { selector: "#double", clickCount: 2 }),
    ).resolves.toMatchObject({ effect: "confirmed", evidence: expect.arrayContaining(["dom"]) });
  }));

it("sees a change inside a shadow root under a clicked point", () =>
  fixture(async (page) => {
    await page.setContent(
      `<div id="host" style="position:absolute;left:10px;top:10px"></div><script>
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = "<span id=s style='display:inline-block;width:60px;height:20px'>save</span>";
        root.getElementById("s").addEventListener("click", (event) => { event.target.firstChild.data = "saved"; });
      </script>`,
    );
    await expect(ServerBrowserPage.click(page, { x: 30, y: 20 })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["dom"]),
    });
  }));

it("does not credit a click with a clock ticking inside its target or an ancestor's attribute timer", () =>
  fixture(async (page) => {
    await page.setContent(
      `<div id="box" style="position:absolute;left:10px;top:10px;width:200px;height:40px">time <span id="clock"></span></div><script>
        setInterval(() => { clock.textContent = String(Date.now()); document.body.dataset.tick = String(Date.now()); }, 1);
      </script>`,
    );
    for (let attempt = 0; attempt < 10; attempt++)
      await expect(ServerBrowserPage.click(page, { x: 30, y: 20 })).resolves.toMatchObject({
        effect: "suspected_noop",
      });
  }));

it("does not credit a click with a navigation earlier work started", () =>
  fixture(async (page) => {
    await page.setContent(
      `<p id="still" style="position:absolute;left:10px;top:10px;margin:0">static</p><script>
        window.later = () => setTimeout(() => { location.hash = "done"; }, 20);
      </script>`,
    );
    await page.evaluate("later()");
    await expect(ServerBrowserPage.click(page, { x: 20, y: 18 })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
    expect(page.url()).toContain("#done");
  }));

it("credits a click's synchronous change to a sibling's attribute or text", () =>
  fixture(async (page) => {
    await page.setContent(
      `<span id="show" onclick="panel.hidden = false">show</span><div id="panel" hidden>panel</div>
       <button id="count" onclick="label.firstChild.data = 'one'">count</button><span id="label">none</span>`,
    );
    await page.focus("#count");
    await expect(ServerBrowserPage.click(page, { selector: "#show" })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["dom"]),
    });
    await expect(ServerBrowserPage.click(page, { selector: "#count" })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["dom"]),
    });
  }));

it("confirms native disclosure and popover toggles, also with the trigger already focused", () =>
  fixture(async (page) => {
    await page.setContent(
      `<details id="d"><summary id="s">more</summary>hidden text</details>
       <button id="p" popovertarget="pop">menu</button><div id="pop" popover>items</div>
       <p id="still">static</p><details id="other"><summary>other</summary>x</details><script>
         setInterval(() => { other.open = !other.open; }, 1);
       </script>`,
    );
    for (const selector of ["#s", "#s", "#p", "#p"])
      await expect(ServerBrowserPage.click(page, { selector })).resolves.toMatchObject({
        effect: "confirmed",
      });
    // The other details toggles on its own meanwhile; a click on plain text is not credited.
    await expect(ServerBrowserPage.click(page, { selector: "#still" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
  }));

it("confirms a popover opened through content nested in its button, by selector and by point", () =>
  fixture(async (page) => {
    await page.setContent(
      `<button id="b" popovertarget="pop" style="position:absolute;left:10px;top:10px"><span id="label">Menu</span></button><div id="pop" popover>items</div>`,
    );
    await page.focus("#b");
    await expect(ServerBrowserPage.click(page, { selector: "#label" })).resolves.toMatchObject({
      effect: "confirmed",
    });
    const box = (await page.locator("#label").boundingBox())!;
    await expect(
      ServerBrowserPage.click(page, { x: box.x + 3, y: box.y + 3 }),
    ).resolves.toMatchObject({ effect: "confirmed" });
  }));

it("confirms a click that starts a download", () =>
  fixture(async (page) => {
    // A served page: an initial about:blank document fires no navigate events.
    await page.route("https://page.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<a id="d" download="report.txt" href="data:text/plain,report">report</a>`,
      }),
    );
    await page.goto("https://page.test/");
    await page.focus("#d");
    await expect(ServerBrowserPage.click(page, { selector: "#d" })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["download"]),
    });
  }));

it("does not confirm a click whose handler rewrites what is already there", () =>
  fixture(async (page) => {
    await page.setContent(
      `<p id="same" aria-expanded="false" onclick="this.setAttribute('aria-expanded', 'false'); this.firstChild.data = 'same'; label.textContent = 'label'">same</p><span id="label">label</span>`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#same" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
  }));

it("confirms a click outside an open popover that dismisses it", () =>
  fixture(async (page) => {
    await page.setContent(
      `<p id="outside" style="position:absolute;left:10px;top:200px;margin:0">outside</p><div id="pop" popover>items</div>`,
    );
    await page.evaluate("pop.showPopover()");
    await expect(ServerBrowserPage.click(page, { x: 30, y: 205 })).resolves.toMatchObject({
      effect: "confirmed",
    });
    expect(await page.evaluate("pop.matches(':popover-open')")).toBe(false);
  }));

it("does not confirm a cancelled popover, a value-less input event, or a node put back in place", () =>
  fixture(async (page) => {
    await page.setContent(
      `<button id="p" popovertarget="pop">menu</button><div id="pop" popover>items</div>
       <input id="i" value="kept" onclick="this.dispatchEvent(new Event('input', { bubbles: true }))">
       <p id="m" onclick="this.append(this.firstChild)"><span>same</span></p><script>
         pop.addEventListener("beforetoggle", (event) => event.newState === "open" && event.preventDefault());
       </script>`,
    );
    await page.focus("#p");
    await expect(ServerBrowserPage.click(page, { selector: "#p" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
    await page.focus("#i");
    await expect(ServerBrowserPage.click(page, { selector: "#i" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
    await expect(ServerBrowserPage.click(page, { selector: "#m" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
  }));

it("still confirms a checkbox toggled through its label and a node moved to a new place", () =>
  fixture(async (page) => {
    await page.setContent(
      `<label id="l"><input type="checkbox" id="c"> agree</label>
       <ul id="list" onclick="this.append(this.firstElementChild)"><li>a</li><li>b</li></ul>`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#l" })).resolves.toMatchObject({
      effect: "confirmed",
    });
    await expect(ServerBrowserPage.click(page, { selector: "#list" })).resolves.toMatchObject({
      effect: "confirmed",
    });
  }));

it("does not confirm a sort that leaves the order as it was, or a node added and removed again", () =>
  fixture(async (page) => {
    await page.setContent(
      `<button id="sort" onclick="list.replaceChildren(...[...list.children].sort((a, b) => a.textContent.localeCompare(b.textContent)))">sort</button>
       <ul id="list"><li>a</li><li>b</li></ul>
       <button id="measure" onclick="const probe = document.createElement('div'); document.body.append(probe); probe.getBoundingClientRect(); probe.remove()">measure</button>`,
    );
    await page.focus("#sort");
    await expect(ServerBrowserPage.click(page, { selector: "#sort" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
    await page.focus("#measure");
    await expect(ServerBrowserPage.click(page, { selector: "#measure" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
  }));

it("does not credit a click with a page load other work started, and does credit a link it follows", () =>
  fixture(async (page) => {
    await page.route("https://page.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<p id="still">static</p><a id="next" href="https://slow.test/next">next</a><script>
          // A poll answered right after the press, by a timer the click has no part in.
          window.poll = () => document.addEventListener("mouseup", () =>
            setTimeout(() => { location.href = "https://slow.test/login"; }, 5), { once: true });
        </script>`,
      }),
    );
    await page.route("https://slow.test/**", () => {});
    await page.goto("https://page.test/");
    await page.evaluate("poll()");
    await expect(ServerBrowserPage.click(page, { selector: "#still" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
    await page.goto("https://page.test/");
    await expect(ServerBrowserPage.click(page, { selector: "#next" })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["navigation"]),
    });
  }));

it("does not confirm a navigation a guard cancelled, or a measuring probe the handler removed", () =>
  fixture(async (page) => {
    await page.route("https://page.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<a id="guarded" href="https://slow.test/next">next</a>
          <button id="measure" onclick="const probe = document.createElement('span'); document.body.append(probe); probe.textContent = 'wide'; probe.style.font = '12px serif'; probe.getBoundingClientRect(); probe.remove()">measure</button><script>
            navigation.addEventListener("navigate", (event) => event.preventDefault());
          </script>`,
      }),
    );
    await page.route("https://page.test/late", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<a id="late" href="https://slow.test/next" onclick="navigation.addEventListener('navigate', (event) => event.preventDefault(), { once: true })">next</a>`,
      }),
    );
    await page.route("https://slow.test/**", () => {});
    await page.goto("https://page.test/");
    await page.focus("#guarded");
    await expect(ServerBrowserPage.click(page, { selector: "#guarded" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
    await page.focus("#measure");
    await expect(ServerBrowserPage.click(page, { selector: "#measure" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
    // A guard added during the click runs after the watch's own navigate listener.
    await page.goto("https://page.test/late");
    await page.focus("#late");
    await expect(ServerBrowserPage.click(page, { selector: "#late" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
  }));

it("confirms a click outside a field whose blur validation it triggered", () =>
  fixture(async (page) => {
    await page.setContent(
      `<input id="name" onchange="saveState.textContent = 'Saved'"><span id="saveState">Unsaved</span>
       <p id="outside" style="margin-top:40px">outside</p>`,
    );
    await page.fill("#name", "Ada");
    await expect(ServerBrowserPage.click(page, { selector: "#outside" })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["dom"]),
    });
    expect(await page.textContent("#saveState")).toBe("Saved");
  }));

it("does not credit a click with a focus or a download other work caused", () =>
  fixture(async (page) => {
    await page.route("https://page.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<p id="still">static</p><input id="search"><a id="export" download="report.txt" href="data:text/plain,report">export</a><script>
          // Earlier work finishes right after this press: it saves an export and focuses search.
          document.addEventListener("mouseup", () => setTimeout(() => {
            document.getElementById("export").click();
            document.getElementById("search").focus();
          }, 5), { once: true });
        </script>`,
      }),
    );
    await page.goto("https://page.test/");
    await expect(ServerBrowserPage.click(page, { selector: "#still" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
  }));

it("credits a popup to the link the click followed, not to one an earlier click opened late", () =>
  fixture(async (page) => {
    await page.route("https://page.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<p id="still">static</p><a id="help" target="_blank" href="https://page.test/help">help</a>`,
      }),
    );
    // An earlier click's window whose first response was slow appears right after this press.
    // Playwright's Page is an event emitter at runtime, though its type does not say so.
    const events = page as unknown as { emit: (event: string, ...args: unknown[]) => boolean };
    await page.exposeFunction("earlierWindowOpens", () => events.emit("popup", page));
    await page.goto("https://page.test/");
    await page.evaluate(
      `document.addEventListener("mouseup", () => earlierWindowOpens(), { once: true })`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#still" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
    await page.focus("#help");
    await expect(ServerBrowserPage.click(page, { selector: "#help" })).resolves.toMatchObject({
      effect: "confirmed",
      evidence: expect.arrayContaining(["popup"]),
    });
  }));

it("does not confirm a new-window link the frame's sandbox blocks", () =>
  fixture(async (page) => {
    await page.route("https://page.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<iframe sandbox="allow-scripts" srcdoc="<a id=help target=_blank href='https://page.test/help'>help</a>"></iframe>`,
      }),
    );
    await page.goto("https://page.test/");
    const help = page.frameLocator("iframe").locator("#help");
    await help.focus();
    await expect(
      ServerBrowserPage.click(page, {
        selector: "iframe >> internal:control=enter-frame >> #help",
      }),
    ).resolves.toMatchObject({ effect: "suspected_noop" });
    expect(page.context().pages()).toHaveLength(1);
  }));

it("does not confirm a link to the fragment the page is already at", () =>
  fixture(async (page) => {
    await page.route("https://page.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<a id="top" href="#">Back to top</a> <h2><a id="self" href="#self">Section</a></h2>`,
      }),
    );
    await page.goto("https://page.test/");
    await page.click("#top");
    await page.focus("#top");
    await expect(ServerBrowserPage.click(page, { selector: "#top" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
    await page.click("#self");
    await page.focus("#self");
    await expect(ServerBrowserPage.click(page, { selector: "#self" })).resolves.toMatchObject({
      effect: "suspected_noop",
    });
  }));

it("a press that only restyles the button or focuses it is not a confirmed click; a state change or a focus move is", () =>
  fixture(async (page) => {
    await page.setContent(
      `<style>.down { color: red } [data-pressed] { color: blue }</style>
       <button id="own" onmousedown="this.classList.add('down')">own</button>
       <button id="icon" onmousedown="this.firstElementChild.classList.add('down')"><i></i>icon</button>
       <button id="sibling" onmousedown="mark.style.color = 'red'">sibling</button><span id="mark">x</span>
       <button id="flag" onmousedown="this.dataset.pressed = ''">flag</button>
       <button id="digit" onclick="display.textContent += '7'">7</button><output id="display"></output>
       <button id="toggle" aria-pressed="false" onclick="this.setAttribute('aria-pressed', 'true')">bold</button>
       <label for="field" id="label">Name</label><input id="field">
       <button id="reveal" onclick="later.hidden = false; later.focus()">edit</button><input id="later" hidden>
       <a id="nav" href="#" onclick="event.preventDefault(); this.setAttribute('aria-current', 'page')">nav</a>`,
    );
    for (const id of ["own", "icon", "sibling", "flag"]) {
      for (const focusedFirst of [false, true]) {
        if (focusedFirst) await page.focus(`#${id}`);
        else await page.focus("#label");
        await expect(
          ServerBrowserPage.click(page, { selector: `#${id}` }),
          `${id}, focused first: ${focusedFirst}`,
        ).resolves.toMatchObject({ effect: "suspected_noop" });
      }
    }
    for (const id of ["digit", "toggle", "nav"])
      await expect(
        ServerBrowserPage.click(page, { selector: `#${id}` }),
        id,
      ).resolves.toMatchObject({
        effect: "confirmed",
        evidence: expect.arrayContaining(["dom"]),
      });
    // A field the click's handler reveals and focuses is the click's; a label handing focus to its
    // control after the dispatch is not attributable to the click and stays unconfirmed.
    await expect(ServerBrowserPage.click(page, { selector: "#reveal" })).resolves.toMatchObject({
      effect: "confirmed",
    });
  }));
