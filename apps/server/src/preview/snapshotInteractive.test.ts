import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { snapshot } from "./ServerBrowserPage.ts";
import { interactiveElementsOf } from "./snapshotInteractive.ts";
import { testActionPage } from "./actionChannel.testkit.ts";

const PAGE = `<p>Article paragraph</p>
<div id="card" style="cursor:pointer" onclick="this.dataset.hit = 'yes'"><span>Open</span><div>card</div></div>
<ul role="listbox" aria-label="Fruits"><li role="option">Apple</li></ul>
<div role="menu"><div role="menuitemcheckbox" aria-checked="true">Bold</div><div role="menuitemradio" aria-checked="false">Left</div></div>
<iframe title="payment" srcdoc="<button>Pay</button>"></iframe>
<input value="draft text">
<button onclick="document.body.dataset.saved = 'yes'">Save</button>`;

// Editable regions show as plain generics, with a ref or, under pointer-events:none, without one.
const FIELDS = `<div style="cursor:pointer"><span>Card</span><input aria-label="Number" value="4111111111111111"><select><option>Visa</option></select><input type="search" value="q-secret"><div contenteditable="true">draft <b>note</b></div><div contenteditable="true"><p>block draft</p><h2>block heading</h2></div><div style="pointer-events:none"><div contenteditable="true">hidden draft</div></div></div>
<iframe title="" srcdoc="<p>Checkout</p><input value='frame-secret'><div contenteditable>frame note</div>"></iframe>`;

// Page text that reads like tree syntax: attributes in names and values, /…/ and lone "/" names, a quoted key.
const SPOOFS = `<button id="b1" aria-label="x [ref=e1] [cursor=pointer] [box=1,2,3,4]">B1</button>
<div id="r1" style="cursor:pointer" aria-label="/a [ref=e2] [box=0,0,1,1]/">R</div>
<div id="q1" role="button" aria-label="/r: [ref=e3] [box=9,9,9,9]/">Q</div>
<a id="l1" href="#" aria-label="it's: [ref=e4] [box=7,7,7,7]">L</a>
<a id="h1" href="#">/</a>
<button id="s1" aria-label="/">x/ [ref=e1] [cursor=pointer] [box=1,2,3,4]</button>
<p>para [ref=e5] [cursor=pointer] [box=5,5,5,5]</p>
<div id="d1" style="cursor:pointer"><span>Pay $&amp; now $1 $$ $\` $'</span><div>x</div></div>
<script>document.addEventListener("click", (event) => { event.preventDefault(); document.body.dataset.hit = event.target.closest("[id]")?.id ?? ""; });</script>`;

// Playwright names a button, link or labelled box after what a field or editor under it shows; the
// last two are a name the page wrote and a listbox whose options are not in its name.
const BORROWED = `<style>.hint::before { content: "Hint" }</style>
<button>Card <input value="4111111111111111"></button>
<a href="#">Card <input value="4111111111111111"></a>
<div role="button" tabindex="0">Card <input value="4111111111111111"></div>
<div style="cursor:pointer" aria-labelledby="f">Card <input id="f" value="4111111111111111"></div>
<button>Card <div contenteditable="true">draft note</div></button>
<button>Card <div contenteditable="true" style="display:inline-block">draft note</div></button>
<button>Card <div style="pointer-events:none"><div contenteditable="true">draft note</div></div></button>
<button>Card <div contenteditable="true"><p>draft note</p></div></button>
<button>Card <div contenteditable="true"><p>draft</p><h2>note</h2></div></button>
<button>Card <div role="textbox" contenteditable="true">draft note</div></button>
<button>Card <div role="textbox" contenteditable="true" placeholder="hint">draft note</div></button>
<a href="#">Card <div role="textbox" contenteditable="true" placeholder="hint">draft note</div></a>
<div role="button" tabindex="0">Card <div role="textbox" contenteditable="true" placeholder="hint">draft note</div></div>
<button>Card <div role="textbox" contenteditable="true">draft note<img alt="x"></div></button>
<button>Card <div role="textbox" contenteditable="true" aria-owns="owned">draft note</div></button>
<div id="owned" role="option">Owned</div>
<button>Card <div role="textbox" contenteditable="true">draft note <ul role="listbox"><li role="option" aria-label="Inner"></li></ul></div></button>
<button>Card <div role="textbox" contenteditable="true">draft note <input aria-label="Inner" placeholder="hint" value="typed"></div></button>
<button>Card <select><option>Visa</option></select></button>
<a href="#">Card <div role="textbox" contenteditable="true" class="hint">draft note</div></a>
<div role="button" tabindex="0">Card <div role="textbox" contenteditable="true" class="hint">draft note</div></div>
<a href="#">Card <input type="range" min="0" max="10" value="7" aria-valuetext="draft note"></a>
<div style="cursor:pointer" aria-labelledby="s">Card <input id="s" type="range" min="0" max="10" value="7" aria-valuetext="draft note"></div>
<button aria-label="Pay now">Card <input value="4111111111111111"></button>
<ul role="listbox" aria-label="Fruits"><li role="option">Apple</li></ul>`;

const withPage = async (html: string, run: (page: Page, cdp: CDPSession) => Promise<void>) => {
  expect(chromiumInstalled).toBe(true);
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await page.setContent(html);
    await run(page, cdp);
  } finally {
    await browser.close();
  }
};

const take = (
  page: Page,
  cdp: CDPSession,
  interactiveOnly?: boolean,
  mask?: (text: string, limit?: number) => string,
) =>
  snapshot({
    page,
    cdp,
    renderScale: 1,
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    captureImage: false,
    timeoutMs: 5000,
    ...(interactiveOnly ? { interactiveOnly } : {}),
    ...(mask ? { diagnostics: { mask } } : {}),
  });

it("an interactive-only snapshot keeps listboxes, menu checkbox and radio items, frames and pointer-cursor elements", () =>
  withPage(PAGE, async (page, cdp) => {
    const tree = String((await take(page, cdp, true)).accessibilityTree);
    expect(tree).toMatch(/^- listbox "Fruits" \[ref=/m);
    expect(tree).toMatch(/^- menuitemcheckbox "Bold" \[checked\] \[ref=/m);
    expect(tree).toMatch(/^- menuitemradio "Left" \[ref=/m);
    expect(tree).toMatch(/^- iframe \[ref=/m);
    expect(tree).toMatch(/^- button "Pay" \[ref=\S+f\d+e\d+\]/m);
    // "card" is the text of a child with its own ref, which keeps it.
    expect(tree).toMatch(/^- generic "Open" \[ref=\S+\] \[cursor=pointer\]/m);
    expect(tree).not.toContain("Article paragraph");
    for (const line of tree.split("\n").slice(1)) expect(line).toMatch(/^- [^\n]*[^:]$/);
    const ref = /^- generic "Open" \[ref=(\S+)\] \[cursor=pointer\]/m.exec(tree)?.[1];
    await testActionPage.click(page, { locator: `aria-ref=${ref}` });
    expect(await page.locator("#card").getAttribute("data-hit")).toBe("yes");
  }));

it("a snapshot lists each interactive ref with a locator that acts on it", () =>
  withPage(PAGE, async (page, cdp) => {
    const result = await take(page, cdp);
    const tree = String(result.accessibilityTree);
    const save = result.interactiveElements.find((element) => element.name === "Save");
    expect(save).toMatchObject({
      role: "button",
      selector: expect.stringMatching(/^aria-ref=t3-/),
    });
    const ref = save!.selector.slice("aria-ref=".length);
    const line = tree.split("\n").find((each) => each.includes(`[ref=${ref}]`));
    expect(line).toContain('button "Save"');
    expect(line).toContain(`[box=${save!.x},${save!.y},${save!.width},${save!.height}]`);
    expect(result.interactiveElements.map((element) => element.role)).toEqual(
      expect.arrayContaining([
        "generic",
        "listbox",
        "option",
        "menuitemcheckbox",
        "menuitemradio",
        "iframe",
        "button",
      ]),
    );
    expect(result.interactiveElements.find((element) => element.name === "Open")?.role).toBe(
      "generic",
    );
    // A field's content is the user's input, never its name.
    expect(result.interactiveElements.find((element) => element.role === "textbox")?.name).toBe("");
    expect(result.interactiveElements.some((element) => element.name.includes("Article"))).toBe(
      false,
    );
    await testActionPage.click(page, { locator: save!.selector });
    expect(await page.locator("body").getAttribute("data-saved")).toBe("yes");
  }));

it("a pointer container or frame is never named after what was typed or chosen in a field under it", () =>
  withPage(FIELDS, async (page, cdp) => {
    const full = await take(page, cdp);
    const narrow = await take(page, cdp, true);
    const names = [...full.interactiveElements, ...narrow.interactiveElements].map(
      (element) => element.name,
    );
    expect(
      names.filter((name) =>
        /4111111111111111|q-secret|frame-secret|Visa|draft|note|block/.test(name),
      ),
    ).toEqual([]);
    expect(String(narrow.accessibilityTree)).toMatch(
      /^- generic "Card" \[ref=\S+\] \[cursor=pointer\]/m,
    );
    expect(full.interactiveElements.some((element) => element.role === "iframe")).toBe(true);
  }));

it("a button, link or labelled box is never named after what a field or editor under it shows", () =>
  withPage(BORROWED, async (page, cdp) => {
    const full = await take(page, cdp);
    const narrow = await take(page, cdp, true);
    for (const { interactiveElements } of [full, narrow]) {
      const names = interactiveElements
        .filter((element) => ["button", "link", "generic"].includes(element.role ?? ""))
        .map((element) => element.name);
      expect(names).toEqual([...Array.from({ length: 22 }, () => "Card"), "Pay now"]);
    }
    const lines = String(narrow.accessibilityTree)
      .split("\n")
      .filter((line) => /^- (?:button|link|generic) /.test(line));
    expect(lines).toHaveLength(23);
    for (const line of lines)
      expect(line).toMatch(/^- (?:button|link|generic) "(?:Card|Pay now)" \[ref=/);
  }));

it("a button whose field a cut tree left out is named only by the text lines kept under it", () => {
  const tree = '- button "Card 4111111111111111" [ref=e2] [box=1,2,3,4]:\n  - text: Card';
  expect(interactiveElementsOf(tree, true)).toEqual([
    expect.objectContaining({ role: "button", name: "Card", selector: "aria-ref=e2" }),
  ]);
});

it("beside a field, a name holding any of the element's own text lines falls back, however long the lines before it", () => {
  const tree = [
    '- button "Save ZZZ" [ref=e2] [box=1,2,3,4]:',
    `  - text: ${"X".repeat(120)}`,
    "  - text: Save",
    "  - textbox [ref=e3] [box=5,6,7,8]: Hint",
  ].join("\n");
  expect(interactiveElementsOf(tree, false)).toContainEqual(
    expect.objectContaining({ role: "button", name: "X".repeat(100) }),
  );
});

it("a name the page wrote stays when nothing under the element shows it", () =>
  withPage(BORROWED, async (page, cdp) => {
    const narrow = await take(page, cdp, true);
    expect(String(narrow.accessibilityTree)).toMatch(/^- button "Pay now" \[ref=/m);
    expect(String(narrow.accessibilityTree)).toMatch(/^- listbox "Fruits" \[ref=/m);
    const { interactiveElements } = await take(page, cdp);
    expect(interactiveElements).toContainEqual(
      expect.objectContaining({ role: "listbox", name: "Fruits" }),
    );
  }));

it("refs, boxes and pointer cursors written in page text never stand in for an element's own", () =>
  withPage(SPOOFS, async (page, cdp) => {
    const narrow = String((await take(page, cdp, true)).accessibilityTree);
    const { interactiveElements } = await take(page, cdp);
    expect(interactiveElements.some((element) => element.role === "paragraph")).toBe(false);
    expect(narrow).not.toContain("paragraph");
    const hit: string[] = [];
    for (const element of interactiveElements) {
      await page.evaluate("delete document.body.dataset.hit");
      await testActionPage.click(page, { locator: element.selector });
      const id = (await page.locator("body").getAttribute("data-hit")) ?? "";
      expect(id, element.name).toMatch(/^[a-z]\d$/);
      const box = (await page.locator(`#${id}`).boundingBox())!;
      expect(element, id).toMatchObject({
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
      hit.push(id);
    }
    expect(hit.sort()).toEqual(["b1", "d1", "h1", "l1", "q1", "r1", "s1"]);
  }));

it("a pointer container's text keeps dollar signs as the page wrote them", () =>
  withPage(SPOOFS, async (page, cdp) => {
    const written = "Pay $& now $1 $$ $` $'";
    const narrow = await take(page, cdp, true);
    expect(String(narrow.accessibilityTree)).toContain(
      `- generic ${JSON.stringify(written)} [ref=`,
    );
    expect(narrow.interactiveElements.map((element) => element.name)).toContain(written);
    expect((await take(page, cdp)).interactiveElements.map((element) => element.name)).toContain(
      written,
    );
  }));

it("an element inside a frame has no box, since the tree measures it from the frame's corner", () =>
  withPage(PAGE, async (page, cdp) => {
    const { interactiveElements } = await take(page, cdp);
    const pay = interactiveElements.find((element) => element.name === "Pay");
    expect(pay?.selector).toMatch(/-f\d+e\d+$/);
    expect(pay).not.toHaveProperty("x");
    expect(pay).not.toHaveProperty("y");
    expect(pay).not.toHaveProperty("width");
    expect(pay).not.toHaveProperty("height");
    const frame = interactiveElements.find((element) => element.role === "iframe");
    const box = (await page.locator("iframe").boundingBox())!;
    expect(frame).toMatchObject({ x: Math.round(box.x), y: Math.round(box.y) });
  }));

it("a tree the tab's mask cuts inside a line never lists that line's page text as an element", () =>
  withPage(
    `<button id="s1" aria-label="/ [ref=e1] [cursor=pointer] [box=9,8,7,6] PAD/">Real</button>
<script>document.addEventListener("click", (event) => { document.body.dataset.hit = event.target.closest("[id]")?.id ?? ""; });</script>
${"<p>filler paragraph that makes the tree longer than its budget</p>".repeat(400)}`,
    async (page, cdp) => {
      // A filled secret's mask cuts a long tree past the limit, then can shorten it under the limit.
      const mask = (text: string, limit?: number) =>
        limit !== undefined && text.length > limit ? text.slice(0, text.indexOf(" PAD/")) : text;
      const { interactiveElements } = await take(page, cdp, false, mask);
      expect(interactiveElements.filter((element) => element.x === 9)).toEqual([]);
      for (const element of interactiveElements) {
        await page.evaluate("delete document.body.dataset.hit");
        await testActionPage.click(page, { locator: element.selector });
        expect(await page.locator("body").getAttribute("data-hit")).toBe("s1");
      }
    },
  ));
