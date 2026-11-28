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
  // The demo world is dated at DEMO_NOW (host/demoWorld.ts); lifted v1 code reads Date.now() itself (devlog 070 A2:
  // frozen clock for the thread view), so the browser clock is fixed there too.
  await page.clock.setFixedTime(new Date(2026, 10, 28, 15, 41, 0));
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
  await page.bringToFront();
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

test("1NEM-1 thread view", async ({ page }) => {
  await open(page, "1NEM-1");
  // v1's timeline (lane F wp6): run-b2 starts without a new user message, so v1 treats everything after the last
  // user message as the live turn: "Working for" under the user message, run-b1's work as a collapsed group, the
  // answer, then the running command. Board 1NEM-1 drew a "Worked for" fold instead (reported to the owner).
  const rows = page.locator("[data-timeline-row-kind]");
  await expect(rows).toHaveCount(5);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-timeline-row-kind")))).toEqual(["message", "working", "work-toggle", "message", "work-live"]);
  await expect(page.getByText("Working for 22s")).toBeVisible();
  await expect(page.getByText("Used 1 tool, changed 1 file, and ran 2 commands")).toBeVisible();
  await expect(page.locator('[data-timeline-row-kind="work-live"]')).toContainText("Running bun");
  await sideBySide(page, "1NEM-1");
});

test("1N65-1 thread mode first entry", async ({ page }) => {
  await open(page, "1N65-1");
  await expect(page.getByText("Priority (2)")).toBeVisible();
  await sideBySide(page, "1N65-1");
});

test("1OXX-1 queued message: edit, reorder via arrows, delete", async ({ page }) => {
  await open(page, "1OXX-1");
  await expect(page.getByText("Also add a regression test for the sidebar key change")).toBeVisible();
  await sideBySide(page, "1OXX-1");
  await page.getByLabel("Edit queued message").click();
  await page.getByLabel("Message", { exact: true }).fill("Also add a regression test (edited)");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page.getByText("Also add a regression test (edited)")).toBeVisible();
  await page.getByLabel("Delete queued message").click();
  await expect(page.getByText("Also add a regression test (edited)")).toHaveCount(0);
});

test("thread mode: open a thread from the rail and back to bots", async ({ page }) => {
  await open(page, "2R-1");
  await page.getByRole("button", { name: "Threads", exact: true }).click();
  await page.locator("[data-thread-row=t-billing]").click();
  await expect(page.locator("[data-timeline=t-billing]")).toBeVisible();
  await page.getByRole("button", { name: "GOAT", exact: true }).first().click();
  await expect(page.getByLabel("Message GOAT")).toBeVisible();
});

test("25D-0 worker thread in the right panel: open, go to thread, back", async ({ page }) => {
  await open(page, "25D-0");
  await expect(page.locator("[data-worker-panel=t-review-7712]")).toContainText("81 passed");
  await sideBySide(page, "25D-0");
  await page.getByLabel("Back to Overview").click();
  await expect(page.getByText("Tasks")).toBeVisible();
  await page.locator("[data-task=t-review-7712]").click();
  await page.getByLabel("Go to thread").click();
  await expect(page.locator("[data-timeline=t-review-7712]")).toBeVisible();
});

test("thread view: reorder queued with arrow keys; edit state resets when switching threads; requests show", async ({ page }) => {
  await open(page, "1OXX-1");
  await page.getByLabel("Message", { exact: true }).fill("second queued");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page.getByText("second queued")).toBeVisible();
  const rows = page.getByLabel("Reorder queued message (arrow keys)");
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[data-timeline] ~ * , body").getByText(/regression test|second queued/).first()).toHaveText("second queued");
  await page.getByLabel("Edit queued message").first().click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("second queued");
  await page.locator("[data-thread-row=t-auth]").click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await expect(page.getByText("Run the e2e suite?")).toBeVisible();
});

test("thread mode: start a thread, approve a request, workspace follows the window height", async ({ page }) => {
  await open(page, "1NEM-1");
  await page.getByLabel("New thread").click();
  await page.getByLabel("Message", { exact: true }).fill("Count the TODOs in api-server");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page.locator("[data-timeline]")).toContainText("Count the TODOs in api-server");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await page.locator("[data-thread-row=t-auth]").click();
  await page.locator("[data-option=accept]").click();
  await expect(page.getByText("Run the e2e suite?")).toHaveCount(0);
  for (const height of [760, 1100]) {
    await page.setViewportSize({ width: 1440, height });
    const bg = await page.locator("[data-workspace-bg]").boundingBox();
    expect(Math.round(bg!.y + bg!.height)).toBe(height);
  }
});

test("thread view: structured question answers", async ({ page }) => {
  await open(page, "1NEM-1");
  await page.locator("[data-thread-row=t-csv]").click();
  await expect(page.locator("[data-option=answered]")).toHaveAttribute("aria-disabled", "true");
  await page.locator("[data-question=columns]").getByRole("button", { name: "Date", exact: true }).click();
  await page.locator("[data-question=columns]").getByRole("button", { name: "Amount", exact: true }).click();
  await expect(page.locator("[data-option=answered]")).toHaveAttribute("aria-disabled", "true");
  await page.locator("[data-question=format]").getByRole("button", { name: "Comma", exact: true }).click();
  await page.locator("[data-option=answered]").click();
  await expect(page.getByText("Which columns go into the export?")).toHaveCount(0);
});

test("question answers survive resolution exactly (single-select vs custom text)", async ({ page }) => {
  await open(page, "1NEM-1");
  await page.locator("[data-thread-row=t-csv]").click();
  await page.locator("[data-question=columns]").getByRole("button", { name: "Customer", exact: true }).click();
  await expect(page.getByLabel("Answer: Format")).toHaveCount(0);
  await page.locator("[data-question=format]").getByRole("button", { name: "Semicolon", exact: true }).click();
  await page.locator("[data-question=name]").getByRole("button", { name: "report.csv", exact: true }).click();
  await page.getByLabel("Answer: File name").fill("  report q4.csv");
  await expect(page.locator("[data-question=name]").getByRole("button", { name: "report.csv", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.locator("[data-option=answered]").click();
  await expect(page.getByText("Which columns go into the export?")).toHaveCount(0);
  const answers = await page.evaluate(() => (window as unknown as { __goat2FakeAnswers?: unknown }).__goat2FakeAnswers);
  expect(answers).toEqual({ columns: ["Customer"], format: "Semicolon", name: "  report q4.csv" });
});

test("thread mode guards: one thread per submit, send while running, one answer at a time", async ({ page }) => {
  await open(page, "1NEM-1");
  await page.getByLabel("New thread").click();
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("Only once please");
  await box.press("Enter");
  await box.press("Enter");
  await page.locator("[data-send]").click({ force: true });
  await expect(page.locator("[data-timeline]")).toContainText("Only once please");
  await expect(page.locator("[data-thread-row]").filter({ hasText: "Only once please" })).toHaveCount(1);
  await page.locator("[data-thread-row=t-billing]").click();
  await box.fill("queue this");
  await expect(page.locator("[data-send]")).toBeVisible();
  await expect(page.getByLabel("Stop")).toBeVisible();
  await page.locator("[data-send]").click();
  await expect(page.getByText("queue this")).toBeVisible();
  await page.locator("[data-thread-row=t-auth]").click();
  await page.locator("[data-option=accept]").dblclick();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Run the e2e suite?")).toHaveCount(0);
});

test("a slow host still gets one start_thread and one resolve_request per action", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?fake=1NEM-1&latency=600");
  await expect(page.getByText("Priority (2)")).toBeVisible({ timeout: 10000 });
  const count = (type: string) => page.evaluate((t) => ((window as unknown as { __goat2Fake: { received: Array<{ type: string }> } }).__goat2Fake.received.filter((f) => f.type === t).length), type);
  await page.getByLabel("New thread").click();
  const box = page.getByLabel("Message", { exact: true });
  await box.fill("Slow host thread");
  await box.press("Enter");
  await box.press("Enter");
  await page.locator("[data-send]").click({ force: true });
  await expect(page.locator("[data-timeline]")).toContainText("Slow host thread", { timeout: 10000 });
  expect(await count("start_thread")).toBe(1);
  await page.locator("[data-thread-row=t-auth]").click();
  await expect(page.locator("[data-option=accept]")).toBeVisible({ timeout: 10000 });
  await page.locator("[data-option=accept]").click();
  await page.locator("[data-option=decline]").click({ force: true });
  await page.locator("[data-option=accept]").click({ force: true });
  await expect(page.getByText("Run the e2e suite?")).toHaveCount(0, { timeout: 10000 });
  expect(await count("resolve_request")).toBe(1);
});
