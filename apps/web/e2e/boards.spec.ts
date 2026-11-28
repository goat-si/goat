// Side-by-side check of every Paper board (docs/PAPER.md §3.5): app shot at the board's size next to
// the board's jpg, written to e2e/out/<id>-sbs.png, plus screen-level assertions and click-throughs.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const boards = join(here, "../../../design/paper/part1");
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync(join(boards, "manifest.json"), "utf8")) as Array<{ id: string; w: number; h: number }>;
const size = (id: string) => manifest.find((b) => b.id === id)!;

async function open(page: Page, id: string) {
  const { w, h } = size(id);
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`/?fake=${id}`);
  await page.waitForTimeout(400);
}

export async function sideBySide(page: Page, id: string) {
  const shot = await page.screenshot({ fullPage: false });
  writeFileSync(join(out, `${id}.png`), shot);
  const { w, h } = size(id);
  const board = readFileSync(join(boards, `${id}.jpg`)).toString("base64");
  const sbs = await page.context().newPage();
  await sbs.setViewportSize({ width: w * 2 + 8, height: h });
  await sbs.setContent(`<body style="margin:0;background:#f0f;display:flex;gap:8px"><img src="data:image/jpeg;base64,${board}" width="${w}" height="${h}"><img src="data:image/png;base64,${shot.toString("base64")}" width="${w}" height="${h}"></body>`);
  await sbs.screenshot({ path: join(out, `${id}-sbs.png`) });
  await sbs.close();
}

test("2R-1 bot home", async ({ page }) => {
  await open(page, "2R-1");
  await expect(page.getByLabel("Message Reviewer")).toBeVisible();
  await expect(page.locator("[data-bot-row=reviewer]")).toContainText("Your call on #7712");
  await expect(page.locator("[data-tile=main]")).toContainText("GOAT");
  await expect(page.getByText("Merge PR #7712 into main?")).toBeVisible();
  await expect(page.getByText("Fix empty list fallback")).toBeVisible();
  await sideBySide(page, "2R-1");
});

test("FF-1 sidebar folds and unfolds", async ({ page }) => {
  await open(page, "2R-1");
  const chatLeft = async () => (await page.getByLabel("Message Reviewer").boundingBox())!.x;
  const before = await chatLeft();
  await page.getByLabel("Toggle main sidebar (⌘B)").first().click();
  await expect(page.locator("[data-sidebar]")).toHaveCount(0);
  expect(await chatLeft()).toBeLessThan(before);
  await page.getByLabel("Toggle main sidebar (⌘B)").first().click();
  await expect(page.locator("[data-sidebar]")).toHaveCount(1);
  await open(page, "FF-1");
  await sideBySide(page, "FF-1");
});

test("U8-1 state notes", async ({ page }) => {
  await open(page, "U8-1");
  await expect(page.getByText("Wicked is asleep.")).toBeVisible();
  await sideBySide(page, "U8-1");
});

test("12P-1 send-first holds the message", async ({ page }) => {
  await open(page, "12P-1");
  await expect(page.getByText("Sent · Reviewer starts when the host connects")).toBeVisible();
  await page.getByLabel("Message Reviewer").fill("one more");
  await page.getByLabel("Message Reviewer").press("Enter");
  await expect(page.getByText("one more")).toBeVisible();
  await sideBySide(page, "12P-1");
});

test("decision answer goes to the host", async ({ page }) => {
  await open(page, "2R-1");
  await page.locator("[data-option=fix]").click();
  await expect(page.getByText("Merge PR #7712 into main?")).toHaveCount(0);
});

test("1KL4-1 rail search adds a bot", async ({ page }) => {
  await open(page, "1KL4-1");
  await page.getByLabel("Add a bot to the rail").first().click();
  await page.getByLabel("Search bots").fill("rev");
  await sideBySide(page, "1KL4-1");
  await page.locator("[data-rail-option=reviewer]").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Reviewer", exact: true }).first()).toBeVisible();
});

test("2PU-1 new bot: create_bot adds the bot", async ({ page }) => {
  await open(page, "2PU-1");
  await expect(page.getByRole("dialog", { name: "New bot" })).toBeVisible();
  await sideBySide(page, "2PU-1");
  await page.getByLabel("Name", { exact: true }).fill("Triage");
  await page.locator("[data-shape=tri]").click();
  await page.locator("[data-color=moss]").click();
  await page.getByLabel("Create bot").click();
  await expect(page.getByRole("dialog", { name: "New bot" })).toHaveCount(0);
  await expect(page.getByLabel("Message Triage")).toBeVisible();
});

test("2D0-1 faces", async ({ page }) => {
  await open(page, "2D0-1");
  await expect(page.getByText("Every bot is a GOAT.")).toBeVisible();
  await sideBySide(page, "2D0-1");
});

test("1FKW-0 drag a row onto the tiles pins it; right-click unpins", async ({ page }) => {
  await open(page, "1FKW-0");
  await page.locator("[data-bot-row=standup]").dragTo(page.locator("[data-pinned-grid]"));
  await expect(page.locator("[data-tile=standup]")).toBeVisible();
  await expect(page.locator("[data-bot-row=standup]")).toHaveCount(0);
  await sideBySide(page, "1FKW-0");
  await page.locator("[data-tile=standup]").click({ button: "right" });
  await expect(page.locator("[data-bot-row=standup]")).toBeVisible();
});
