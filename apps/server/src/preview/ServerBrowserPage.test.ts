// @effect-diagnostics nodeBuiltinImport:off - existence of Playwright's browser binary is a Node filesystem check.
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Dialog,
  type Page,
} from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { inputFence } from "./PreviewInputFence.ts";
import * as PreviewUpload from "./PreviewUpload.ts";
import { watchPrivateMode } from "./PreviewPrivateMode.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";

// `chromium.launch({ headless: true })` starts chromium-headless-shell.
// `chromium.executablePath()` is the full Chrome build, so it stays missing
// after `install --only-shell`. Linux CI installs the shell; a Mac checkout
// often has not. Skip the live cases instead of failing the file. The drag
// case below does not launch anything.
const chromiumInstalled = (() => {
  try {
    const require = NodeModule.createRequire(import.meta.url);
    const packageRoot = NodePath.dirname(require.resolve("playwright-core/package.json"));
    const browsers = JSON.parse(
      NodeFS.readFileSync(NodePath.join(packageRoot, "browsers.json"), "utf8"),
    ) as {
      browsers: ReadonlyArray<{ name: string; revision: string }>;
    };
    const revision = browsers.browsers.find(
      (browser) => browser.name === "chromium-headless-shell",
    )?.revision;
    if (revision === undefined) return false;
    const platform = HostProcess.Platform.defaultValue();
    const arch = HostProcess.Architecture.defaultValue();
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const registry =
      browsersPath === "0"
        ? NodePath.join(packageRoot, ".local-browsers")
        : browsersPath
          ? NodePath.resolve(process.env.INIT_CWD || process.cwd(), browsersPath)
          : NodePath.join(
              platform === "linux"
                ? process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache")
                : platform === "darwin"
                  ? NodePath.join(NodeOS.homedir(), "Library", "Caches")
                  : process.env.LOCALAPPDATA || NodePath.join(NodeOS.homedir(), "AppData", "Local"),
              "ms-playwright",
            );
    const directory = NodePath.join(registry, `chromium_headless_shell-${revision}`);
    const executable =
      platform === "win32"
        ? ["chrome-headless-shell-win64", "chrome-headless-shell.exe"]
        : platform === "darwin"
          ? [
              arch === "arm64"
                ? "chrome-headless-shell-mac-arm64"
                : "chrome-headless-shell-mac-x64",
              "chrome-headless-shell",
            ]
          : arch === "arm64"
            ? ["chrome-linux", "headless_shell"]
            : ["chrome-headless-shell-linux64", "chrome-headless-shell"];
    return NodeFS.existsSync(NodePath.join(directory, ...executable));
  } catch {
    return false;
  }
})();

describe.skipIf(!chromiumInstalled)("server browser element refs", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const takeSnapshot = () =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      timeoutMs: 15_000,
    });

  it("never clicks after Stop, even when Playwright was still waiting for the target", async () => {
    await page.setContent('<button id="b" disabled onclick="window.clicked = true">Send</button>');
    let stopped = false;
    const clicking = ServerBrowserPage.click(
      page,
      { locator: "#b", timeoutMs: 10_000 },
      undefined,
      () => {
        if (stopped) throw new Error("stopped");
      },
    );
    void clicking.catch(() => undefined);
    // A person stops the agent while the click waits for the button, which then becomes usable.
    stopped = true;
    await page.evaluate("document.getElementById('b').disabled = false");
    await expect(clicking).rejects.toThrow("stopped");
    expect(await page.evaluate("window.clicked === true")).toBe(false);
  });

  it("clears and types only into the target, never into another focused field", async () => {
    await page.setContent(
      '<input id="target" disabled value="old"><input id="other" value="keep">',
    );
    await page.focus("#other");
    await expect(
      ServerBrowserPage.type(page, { locator: "#target", clear: true, text: "WRONG" }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTargetNotEditableError" });
    expect(await page.evaluate("[target.value, other.value]")).toEqual(["old", "keep"]);

    await page.evaluate("target.disabled = false");
    await ServerBrowserPage.type(page, { locator: "#target", clear: true, text: "NEW" });
    expect(await page.evaluate("[target.value, other.value]")).toEqual(["NEW", "keep"]);
  });

  it("sends no input while it waits for a drag's ends, so a stopped drag leaves no trace", async () => {
    await page.setContent(
      '<div id="a" draggable="true">a</div><div id="b">b</div><script>window.seen = []; for (const type of ["pointermove", "pointerdown", "pointerup", "click"]) addEventListener(type, (event) => seen.push(type), true)</script>',
    );
    const stopped = () => {
      throw new Error("stopped");
    };
    await expect(
      ServerBrowserPage.drag(page, { source: "#a", target: "#b" }, undefined, stopped),
    ).rejects.toThrow("stopped");
    expect(await page.evaluate("window.seen")).toEqual([]);
  });

  it("answers a click without waiting for the navigation it starts", async () => {
    const response = Promise.withResolvers<void>();
    await page.route("https://slow.test/next", async (route) => {
      await response.promise;
      await route.fulfill({ contentType: "text/html", body: "<p>next</p>" });
    });
    await page.setContent('<a id="go" href="https://slow.test/next">next</a>');
    await ServerBrowserPage.click(page, { locator: "#go", timeoutMs: 5_000 });
    response.resolve();
    await page.waitForURL("https://slow.test/next");
  });

  it("never sends a double click's second press once its first opened a dialog", async () => {
    await page.setContent(
      '<button id="b" onclick="window.hits = (window.hits || 0) + 1; if (window.hits === 1) confirm(\'sure?\')">Go</button>',
    );
    const control = new SessionControl("agent");
    control.onDispatchCut(inputFence(cdp));
    const dialog = new Promise<Dialog>((resolve) => page.once("dialog", resolve));
    await control.agent("agent", () =>
      ServerBrowserPage.click(
        page,
        { locator: "#b", clickCount: 2 },
        undefined,
        control.dispatchGate(),
      ),
    );
    // Stop while the first press waits on the dialog, then a person answers it.
    control.stopAgents();
    await (await dialog).dismiss();
    await control.system(async () => {});
    expect(await page.evaluate("window.hits")).toBe(1);
  });

  it("clears a single select when given no values", async () => {
    await page.setContent(
      '<select id="s"><option value="a">A</option><option value="b" selected>B</option></select>',
    );
    expect(await ServerBrowserPage.select(page, { locator: "#s", values: [] })).toEqual({
      selected: [],
    });
    expect(await page.evaluate("s.selectedIndex")).toBe(-1);
  });

  it("holds a click that passed its gate when Stop arrives, and lets input through after", async () => {
    await page.setContent(
      '<button id="b" onclick="window.clicks = (window.clicks || 0) + 1">Send</button>',
    );
    const control = new SessionControl("agent");
    control.onDispatchCut(inputFence(cdp));
    const clicking = control.agent("agent", () => {
      const gate = control.dispatchGate();
      return ServerBrowserPage.click(page, { locator: "#b" }, undefined, () => {
        gate();
        // Stop lands after the gate, while Playwright still has the click to send.
        control.stopAgents();
      });
    });
    await expect(clicking).rejects.toMatchObject({ reason: "stopped" });
    // Drains the stopped action, which releases the fence.
    await control.system(async () => {});
    expect(await page.evaluate("window.clicks ?? 0")).toBe(0);
    await page.locator("#b").click();
    expect(await page.evaluate("window.clicks")).toBe(1);
  });

  it("does not click a covered target, even though waiting for it sends no input", async () => {
    await page.setContent(
      '<button id="b" onclick="window.hits.push(\'target\')">Send</button><div id="o" style="position:fixed;inset:0" onclick="window.hits.push(\'overlay\')"></div><script>window.hits = []</script>',
    );
    // The button is visible, enabled and stable, so only Playwright's own check after the gate
    // can see that the overlay would take the click.
    await expect(ServerBrowserPage.click(page, { locator: "#b" })).rejects.toThrow();
    expect(await page.evaluate("window.hits")).toEqual([]);
  });

  it("never selects or uploads after Stop, even when the target appears later", async () => {
    await page.setContent('<select id="s"><option value="a">A</option></select>');
    const stopped = () => {
      throw new Error("stopped");
    };
    await expect(
      ServerBrowserPage.select(page, { locator: "#s", values: ["b"] }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationExecutionError" });
    await page.evaluate("s.add(new Option('B', 'b'))");
    await expect(
      ServerBrowserPage.select(page, { locator: "#s", values: ["b"] }, stopped),
    ).rejects.toThrow("stopped");
    expect(await page.evaluate("s.value")).toBe("a");

    const uploading = PreviewUpload.setInputFiles(
      page,
      cdp,
      { locator: "#f", paths: [NodePath.join(NodeOS.tmpdir(), "missing-upload.txt")] },
      stopped,
    );
    void uploading.catch(() => undefined);
    await page.evaluate("document.body.insertAdjacentHTML('beforeend', '<input id=f type=file>')");
    await expect(uploading).rejects.toThrow("stopped");
    expect(await page.evaluate("f.files.length")).toBe(0);
  });

  it("uploads through a label in one call after the gate, and refuses a framed input", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-upload-"));
    using _removeDirectory = {
      [Symbol.dispose]: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
    };
    const file = NodePath.join(directory, "note.txt");
    NodeFS.writeFileSync(file, "hello");
    await page.setContent(
      '<label id="l">Attach <input id="f" type="file"></label><iframe srcdoc="<input id=g type=file>"></iframe><script>window.changes = 0; f.addEventListener("change", () => changes++)</script>',
    );
    let gates = 0;
    await PreviewUpload.setInputFiles(page, cdp, { locator: "#l", paths: [file] }, () => {
      gates++;
    });
    expect(gates).toBe(1);
    expect(await page.evaluate("[f.files[0]?.name, window.changes]")).toEqual(["note.txt", 1]);
    await expect(
      PreviewUpload.setInputFiles(
        page,
        cdp,
        { locator: "iframe >> internal:control=enter-frame >> #g", paths: [file] },
        () => gates++,
      ),
    ).rejects.toThrow(/inside a frame/);
    expect(gates).toBe(1);
  });

  it("skips the capture for a text-only snapshot and still returns the page", async () => {
    await page.setContent("<main><h1>Inbox</h1><button>Compose</button></main>");
    const result = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      captureImage: false,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      timeoutMs: 15_000,
    });
    expect(result.screenshot).toBeUndefined();
    expect(String(result.accessibilityTree)).toContain("Compose");
  });

  it("captures a full document without changing viewport, scroll, or responsive layout", async () => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent(
      "<style>body{margin:0} main{height:2900px} footer{height:100px;background:rgb(255,0,0)}</style><main>Long page</main><footer></footer>",
    );
    await page.evaluate("scrollTo(0, 450)");
    const result = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      fullPage: true,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      timeoutMs: 15_000,
    });
    expect(result.screenshot).toMatchObject({ width: 800, height: 3000, clipped: false });
    const bottomPixel = await page.evaluate(`(async () => {
      const image = new Image();
      image.src = "data:image/png;base64,${result.screenshot!.data}";
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(10, 2990, 1, 1).data);
    })()`);
    expect(bottomPixel).toEqual([255, 0, 0, 255]);
    expect(page.viewportSize()).toEqual({ width: 800, height: 600 });
    expect(
      await page.evaluate("({x: scrollX, y: scrollY, width: innerWidth, height: innerHeight})"),
    ).toEqual({ x: 0, y: 450, width: 800, height: 600 });
    const viewport = await takeSnapshot();
    expect(viewport.screenshot).toMatchObject({ width: 800, height: 600 });
  });

  it("captures CSS pixels from a real Retina document", async () => {
    const retina = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
    });
    try {
      const retinaPage = await retina.newPage();
      await retinaPage.setContent("<style>body{margin:0;height:3000px}</style>Retina");
      const result = await ServerBrowserPage.snapshot({
        page: retinaPage,
        cdp: await retina.newCDPSession(retinaPage),
        renderScale: 2,
        fullPage: true,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
        timeoutMs: 15_000,
      });
      expect(result.screenshot).toMatchObject({ width: 800, height: 3000, clipped: false });
      const image = Buffer.from(result.screenshot!.data, "base64");
      expect(image.readUInt32BE(16)).toBe(800);
      expect(image.readUInt32BE(20)).toBe(3000);
      expect(result.screenshot!.byteLength).toBe(image.length);
      expect(result.screenshot!.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    } finally {
      await retina.close();
    }
  });
  const locators = (tree: unknown) => {
    expect(typeof tree).toBe("string");
    return Array.from(
      String(tree).matchAll(/\[ref=([^\]]+)\]/g),
      (match) => `aria-ref=${match[1]}`,
    );
  };
  const buttonLocator = (tree: unknown, name: string) => {
    const line = String(tree)
      .split("\n")
      .find((line) => line.includes(`button "${name}"`));
    const locator = locators(line)[0];
    expect(locator).toBeDefined();
    return locator!;
  };
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("clicks the fifth repeated delete control without touching row one", async () => {
    await page.setContent(repeatedRows);
    const result = await takeSnapshot();
    const buttons = String(result.accessibilityTree)
      .split("\n")
      .filter((line) => line.includes('button "delete"'));
    expect(buttons).toHaveLength(5);
    await ServerBrowserPage.click(page, { locator: locators(buttons[4])[0]! });
    expect(await page.locator("li").allTextContents()).toEqual([
      "row 1delete",
      "row 2delete",
      "row 3delete",
      "row 4delete",
    ]);
  });

  it("returns from a click once it opens a dialog", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`,
    );
    const dialog = new Promise<import("playwright-core").Dialog>((resolve) =>
      page.once("dialog", resolve),
    );
    await ServerBrowserPage.click(page, {
      locator: buttonLocator((await takeSnapshot()).accessibilityTree, "Confirm"),
    });
    await (await dialog).accept();
    await expect.poll(() => page.locator("body").getAttribute("data-answer")).toBe("true");
  });

  it("rejects ambiguous CSS controls without clicking any row", async () => {
    await page.setContent(repeatedRows);
    await expect(
      ServerBrowserPage.click(page, {
        selector: 'button[data-testid="delete-row"]',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/strict mode violation/);
    expect(await page.locator("li").count()).toBe(5);
  });

  it("does not retarget a removed ref to a replacement node", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">original</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page.setContent("<button onclick=\"this.textContent='clicked'\">replacement</button>");
    await expect(ServerBrowserPage.click(page, { locator, timeoutMs: 100 })).rejects.toThrow();
    expect(await page.locator("button").textContent()).toBe("replacement");
  });

  it("targets iframe input refs and preserves the parent form", async () => {
    await page.setContent(
      '<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>',
    );
    await page.frameLocator("iframe").getByRole("textbox").waitFor();
    const result = await takeSnapshot();
    const line = String(result.accessibilityTree)
      .split("\n")
      .find((line) => line.includes('textbox "child"'));
    const locator = locators(line)[0]!;
    await ServerBrowserPage.type(page, { locator, text: "inside iframe", clear: true });
    expect(await page.frameLocator("iframe").getByRole("textbox").inputValue()).toBe(
      "inside iframe",
    );
    expect(await page.getByRole("textbox", { name: "parent" }).inputValue()).toBe("");
  });

  it("shows dotted fields as dots wherever their value appears, keeping text values and refs", async () => {
    await page.setContent(`
      <table><tr><td>password:</td><td><input id="pw" type="password" aria-label="Password"></td></tr></table>
      <input aria-label="Username" value="maria">
      <input type="password" aria-label='saved" [ref=e2]: x' placeholder="hint" value="saved-pass">
      <input type="password" role="combobox" aria-label="Code" value="role-pass">
      <input aria-label="PIN" style="-webkit-text-security: disc" value="styled-pass">
      <div contenteditable style="-webkit-text-security: disc">editable-pass</div>
      <iframe srcdoc="<input type=password aria-label=child value=frame-pass>"></iframe>
      <iframe id="blank" src="javascript:false"></iframe>
      <p>Order styled-pass-2</p>
      <script>
        // A frame that never commits a document, filled by its parent.
        blank.contentDocument.body.innerHTML = "<input type=password aria-label=blank value=blank-pass>";
        // Page script can't change the value the snapshot sees.
        Object.defineProperty(HTMLInputElement.prototype, "value", { get: () => "" });
      </script>`);
    await page.frameLocator("iframe[srcdoc]").getByRole("textbox").waitFor();
    await ServerBrowserPage.type(page, { locator: "#pw", text: "typed-pass" });
    const result = await takeSnapshot();
    const tree = String(result.accessibilityTree);
    expect(tree).toContain('textbox "blank"');
    expect(tree).not.toMatch(
      /typed-pass|saved-pass|role-pass|styled-pass|editable-pass|frame-pass|blank-pass/,
    );
    expect(result.visibleText).not.toContain("editable-pass");
    expect(result.visibleText).toContain("Order ••••••••-2");
    expect(tree).toMatch(/row "password: •+"/);
    expect(tree).toMatch(/textbox "Username" [^\n]*: maria$/m);
    const line = tree.split("\n").find((line) => line.includes('textbox "Password"'));
    expect(line).toMatch(/: •+$/);
    await ServerBrowserPage.type(page, { locator: locators(line)[0]!, text: "next", clear: true });
    expect(await page.locator("#pw").inputValue()).toBe("next");
  });

  it("masks dotted values in page text next to punctuation, with odd spaces, and at the cut", async () => {
    await page.setContent(`
      <input type="password" aria-label="PIN" value="123">
      <input type="password" aria-label="Phrase" value="open&nbsp;sesame">
      <p>PIN: 123. Code (123) id 1234</p>
      <p>open&nbsp;sesame</p>`);
    const text = (await takeSnapshot()).visibleText;
    expect(text).toContain("PIN: ••••••••. Code (••••••••) id 1234");
    expect(text).not.toMatch(/open|sesame/);
    await page.setContent(`
      <p>${"x".repeat(19_995)}long-secret</p>
      <input type="password" aria-label="Long" value="long-secret">`);
    const cut = (await takeSnapshot()).visibleText;
    expect(cut.length).toBe(20_000);
    expect(cut.slice(-8)).toBe("xxx•••••");
  });

  it("shows a data: link or blocked data: navigation by media type only", async () => {
    // Chromium keeps raw spaces and quotes in both, so a payload can't be cut at either.
    await page.setContent(`
      <a download href="data:text/plain;charset=&quot;a,b&quot;,head PAYLOAD'tail">Key</a>
      <a href="https://example.com/data:report,2026">Report</a>
      <a href="#">data:text/plain,label</a>
      <a href='"data:text/plain,relative'>Relative</a>
      <a href=" data:text/plain,PAYLOAD">Spaced</a>
      <a href="da&#9;ta:text/plain,PAYLOAD">Tabbed</a>
      <a href="data:text/plain,head&#x2028;PAYLOAD">Separated</a>
      <a href="data:PAYLOAD,x">Typeless</a>
      <a href="&#11;data:text/plain,PAYLOAD">Vertical tab</a>
      <a href="&#8;data:text/plain,PAYLOAD">Backspace</a>
      <a id="controlled">Controlled</a>
      <a id="escaped">Escaped</a>
      <script>
        controlled.href = "\\x01data:text/plain,PAYLOAD";
        escaped.href = "\\x02da\\tta:text/plain,PAYLOAD";
      </script>`);
    const tree = String((await takeSnapshot()).accessibilityTree);
    expect(tree.match(/\/url: data:text\/plain,…$/gm)).toHaveLength(8);
    expect(tree).toContain("/url: data:,…");
    expect(tree).toContain("/url: https://example.com/data:report,2026");
    expect(tree).toMatch(/link "data:text\/plain,label" \[ref=t3-/);
    expect(tree).not.toMatch(/PAYLOAD|tail|charset|\u2028/);
    expect(tree).toContain('/url: "\\"data:text/plain,relative"');
  });

  it("redacts a data: link whose scheme a password value would mask", async () => {
    await page.setContent(`
      <input type="password" aria-label="Scheme" value="data">
      <a download href="data:text/plain,PAYLOAD">Key</a>`);
    const tree = String((await takeSnapshot()).accessibilityTree);
    expect(tree).toContain("/url: ••••••••:text/plain,…");
    expect(tree).not.toContain("PAYLOAD");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "css=body >> aria-ref=e1"])(
    "does not allow native refs to bypass generation validation (%s)",
    async (locator) => {
      await page.setContent("<button>continue</button>");
      await takeSnapshot();
      await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    },
  );

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it.each(["hidden", "detached"] as const)("waits for an element to become %s", async (state) => {
    await page.setContent('<div id="dialog">Dialog</div>');
    const waiting = ServerBrowserPage.waitFor(page, {
      locator: "#dialog",
      state,
    });
    let finished = false;
    void waiting.then(
      () => {
        finished = true;
      },
      // A failure surfaces once, at the await below.
      () => undefined,
    );
    await page.evaluate("document.body.innerText");
    expect(finished).toBe(false);
    await page.evaluate(state === "hidden" ? 'dialog.style.display = "none"' : "dialog.remove()");
    await waiting;
    expect(await page.locator("#dialog").count()).toBe(state === "hidden" ? 1 : 0);
    expect(await page.locator("#dialog").isVisible()).toBe(false);
  });

  it("keeps legacy attachment waits for hidden and repeated matches", async () => {
    await page.setContent('<div class="match" hidden>one</div><div class="match" hidden>two</div>');
    await ServerBrowserPage.waitFor(page, { selector: ".match" });
  });

  it("requires all conditions to hold together, including same-document URL changes", async () => {
    await page.route("https://wait.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="ready">Ready</div>',
      }),
    );
    await page.goto("https://wait.test/");
    const waiting = ServerBrowserPage.waitFor(page, {
      locator: "#ready",
      state: "visible",
      text: "Done",
      urlIncludes: "#done",
    });
    await page.evaluate(
      'ready.hidden = true; document.body.append("Done"); history.pushState({}, "", "#done")',
    );
    let finished = false;
    void waiting.then(
      () => {
        finished = true;
      },
      // A failure surfaces once, at the await below.
      () => undefined,
    );
    // A round trip after every other condition holds must not finish a hidden-target wait.
    await page.evaluate("document.body.innerText");
    expect(finished).toBe(false);
    await page.evaluate("ready.hidden = false");
    await waiting;
    expect(page.url()).toBe("https://wait.test/#done");
  });

  it("follows a replacement document instead of accepting the old document's load", async () => {
    const routed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("https://wait.test/**", async (route) => {
      if (route.request().resourceType() === "image") {
        routed.resolve();
        await release.promise;
describe("server browser snapshot screenshot", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    // ServerBrowserContexts launches with these, and the capture scale depends on them.
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu", "--force-device-scale-factor=2"],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
  });
  afterEach(async () => {
    await context.close();
  });

  // Blue on the left half and red on the right, so a mirrored left half shows up on the right.
  const halves = (overlay: string) => `
    <style>
      body { margin: 0; background: white; }
      .half { position: absolute; top: 0; width: 640px; height: 800px; }
      .overlay { position: fixed; inset: 0; ${overlay} }
    </style>
    <div class="half" style="left: 0; background: #2563eb"></div>
    <div class="half" style="left: 640px; background: #ef4444"></div>
    <div class="overlay"></div>`;

  const screenshotOf = async (html: string) => {
    const page = await context.newPage();
    await page.setContent(html);
    const { screenshot } = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
    // The server has no DOM types, so the decoder runs as page source.
    const points = [
      [0.15, 0.75],
      [0.85, 0.25],
      [0.85, 0.75],
    ];
    const pixels = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(screenshot.data)}), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return ${JSON.stringify(points)}.map(([x, y]) =>
        Array.from(context.getImageData(x * bitmap.width, y * bitmap.height, 1, 1).data),
      );
    })()`)) as Array<[number, number, number, number]>;
    return { screenshot, pixels };
  };
  const colorOf = ([red, green, blue]: readonly [number, number, number, number]) =>
    blue - red > 100 ? "blue" : red - blue > 100 ? "red" : `rgb(${red}, ${green}, ${blue})`;

  it("captures a blurred backdrop-filter page as rendered, not mirrored", async () => {
    const { screenshot, pixels } = await screenshotOf(halves("backdrop-filter: blur(4px);"));

    expect({
      size: [screenshot.width, screenshot.height],
      colors: pixels.map(colorOf),
    }).toEqual({ size: [1280, 800], colors: ["blue", "red", "red"] });
  });

  it("captures a plain page at the shrunk size with its content in place", async () => {
    const { screenshot, pixels } = await screenshotOf(halves(""));

    expect({
      size: [screenshot.width, screenshot.height],
      colors: pixels.map(colorOf),
    }).toEqual({ size: [1280, 800], colors: ["blue", "red", "red"] });
  });

  it("shrinks the screenshot of an XML document, whose createElement makes no canvas", async () => {
    const page = await context.newPage();
    await page.goto("data:text/xml,<a/>");
    const { screenshot } = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });

    expect([screenshot.width, screenshot.height]).toEqual([1280, 800]);
  });
});

describe("server browser drag", () => {
  it("fails the drag, not the server, when it times out while the cursor is still moving", async () => {
    const timedOut = new Error("locator.dragTo: Timeout 30000ms exceeded.");
    const box = { x: 0, y: 0, width: 20, height: 20 };
    const targetBox = Promise.withResolvers<typeof box>();
    const page = {
      locator: (selector: string) =>
        selector === "#card"
          ? {
              scrollIntoViewIfNeeded: async () => {},
              boundingBox: async () => box,
              dragTo: () => Promise.reject(timedOut),
            }
          : { boundingBox: () => targetBox.promise },
    } as unknown as Page;
    const unobserved: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let finished = false;
      const settled = ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }).then(
        () => null,
        (error: unknown) => error,
      );
      void settled.then(() => (finished = true));
      // Two macrotask turns: Node reports a rejection nobody observed after the first.
      for (let turn = 0; turn < 2; turn++) {
        // oxlint-disable-next-line goat/no-real-time-wait-in-tests -- Node emits unhandledRejection only between macrotasks; no promise can mark that point.
        await new Promise((resolve) => setImmediate(resolve));
      }
      await route.fulfill({
        contentType: "text/html",
        body: '<p>New document</p><img src="/slow.png">',
      });
    });
    const waiting = ServerBrowserPage.waitFor(page, {
      text: "New document",
      urlIncludes: "wait.test",
      loadState: "load",
    });
    let finished = false;
    void waiting.then(
      () => {
        finished = true;
      },
      // A failure surfaces once, at the await below.
      () => undefined,
    );
    try {
      await page.goto("https://wait.test/", { waitUntil: "domcontentloaded" });
      await routed.promise;
      expect(await page.evaluate("document.readyState")).toBe("interactive");
      expect(finished).toBe(false);
      release.resolve();
      await waiting;
      expect(await page.evaluate("document.readyState")).toBe("complete");
    } finally {
      release.resolve();
    }
  });

  it("times out at the requested load milestone", async () => {
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("https://wait.test/**", async (route) => {
      if (route.request().resourceType() === "image") {
        requested.resolve();
        await release.promise;
      }
      await route.fulfill({ contentType: "text/html", body: '<img src="/slow.png">' });
    });
    try {
      await page.goto("https://wait.test/", { waitUntil: "domcontentloaded" });
      await requested.promise;
      await ServerBrowserPage.waitFor(page, { loadState: "domContentLoaded" });
      await expect(
        ServerBrowserPage.waitFor(page, { loadState: "load", timeoutMs: 100 }),
      ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    } finally {
      release.resolve();
    }
  });

  it("only waits for network idle when explicitly requested, with a bounded deadline", async () => {
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("https://wait.test/**", async (route) => {
      if (route.request().resourceType() === "fetch") {
        requested.resolve();
        await release.promise;
      }
      await route.fulfill({
        contentType: "text/html",
        body: '<p>Ready</p><script>fetch("/busy")</script>',
      });
    });
    try {
      await page.goto("https://wait.test/");
      await requested.promise;
      await ServerBrowserPage.waitFor(page, { text: "Ready" });
      await expect(
        ServerBrowserPage.waitFor(page, { loadState: "networkIdle", timeoutMs: 100 }),
      ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
      release.resolve();
      await ServerBrowserPage.waitFor(page, { loadState: "networkIdle" });
    } finally {
      release.resolve();
    }
  });
});

describe.skipIf(!chromiumInstalled)("server browser private mode", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  /** Each change the watcher reports, resolved in order. */
  let changes: Array<PromiseWithResolvers<boolean>>;
  let reported: number;
  let delivered: number;
  const nextChange = () => changes[reported++]!.promise;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    changes = Array.from({ length: 8 }, () => Promise.withResolvers<boolean>());
    reported = 0;
    delivered = 0;
    await watchPrivateMode(page, (on) => changes[delivered++]!.resolve(on));
    // Bindings are answered in order, so awaiting this one means every earlier report arrived.
    await page.exposeFunction("__fence", () => undefined);
  });
  afterEach(async () => {
    await context.close();
  });

  // A navigation runs the watcher's script, and passkeys need a secure origin.
  const load = async (body: string) => {
    await page.route("https://login.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body }),
    );
    await page.goto("https://login.example/");
  };

  it("goes private while a password or one-time code field has focus, and back when it leaves", async () => {
    await load(
      '<input id="user"><input id="pass" type="password"><input id="otp" autocomplete="one-time-code">',
    );
    await page.focus("#pass");
    expect(await nextChange()).toBe(true);
    await page.focus("#user");
    expect(await nextChange()).toBe(false);
    await page.focus("#otp");
    expect(await nextChange()).toBe(true);
  });

  it("stays private through history and hash moves, and clears only for a new document", async () => {
    await load('<input id="pass" type="password">');
    await page.focus("#pass");
    expect(await nextChange()).toBe(true);
    await page.evaluate("history.pushState({}, '', '/step-2'); location.hash = 'otp'");
    await page.evaluate("window.__fence()");
    expect(delivered).toBe(1);
    await page.goto("https://login.example/done");
    expect(await nextChange()).toBe(false);
  });

  it("goes private for a passkey prompt until it settles, inside a frame too", async () => {
    await load('<iframe srcdoc="<p>sign in</p>"></iframe>');
    const frame = page.frames()[1]!;
    await frame.waitForLoadState();
    // Headless Chromium has no authenticator, so the ceremony fails; the prompt still counted.
    void frame.evaluate(
      "navigator.credentials.get({ publicKey: { challenge: new Uint8Array(16), timeout: 1000 } }).catch(() => {})",
    );
    expect(await nextChange()).toBe(true);
    expect(await nextChange()).toBe(false);
  });
});
