// Provider surfaces on the fake host (Part 2, lane P2-M): the GOAT 2 provider screens over the approved provider
// frames (docs/part2/provider-wire.md). Boards (design/paper/part2): 1PBB-2 list + detail, 1Q0P-2 sign-in, 1QAN-2
// catalog, 2LET-2 cloud opt-in, 2LEU-2 repair / install / accounts, 2LEV-2 first run, 1QM8-2 / 1QYE-2 pickers.
import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

const sent = (page: Page, type: string) =>
  page.evaluate((t) => (window as unknown as { __goat2Fake: { received: Array<Record<string, unknown>> } }).__goat2Fake.received.filter((f) => f.type === t), type);
const sidebar = (page: Page) => page.locator("[data-providers-sidebar]");
const main = (page: Page) => page.locator("[data-providers-main]");
const row = (page: Page, id: string) => sidebar(page).locator(`[data-provider-row="${id}"]`);

test("Providers lists the added providers with their state; every local kind is listed or in the catalog", async ({ page }) => {
  await page.goto("/?fake=1PBB-2");
  const rows: Array<[string, string]> = [
    ["codex", "Codex · PersonalReady · ChatGPT Pro"], ["codex-2", "Codex · WorkReady · ChatGPT Team"], ["claudeAgent", "ClaudeNeeds sign-in"],
    ["cursor", "CursorReady · Cursor account"], ["opencode", "OpenCodeReady · 3 providers"], ["antigravity", "AntigravityNeeds sign-in"],
    ["pi", "PiReady"], ["omo", "OmONeeds repair"], ["acp-kimi-code", "Kimi CodeReady"], ["acp-kilo", "KiloInstalling · 62%"],
  ];
  for (const [id, textContent] of rows) await expect(row(page, id), id).toHaveText(textContent);
  await expect(main(page).getByRole("heading")).toHaveText("Codex · Personal");
  await expect(main(page).locator("[data-provider-state]")).toHaveText("Ready · v0.167.0 · checked just now");
  await expect(main(page).getByLabel("Account")).toContainText("y•••@example.com · ChatGPT Pro");
  await expect(main(page).getByLabel("Models")).toContainText("GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Luna and 1 more");
  // Grok, fx and Muse Code are not added: the catalog has them, so all 11 local kinds are reachable.
  await sidebar(page).getByRole("button", { name: "Add a provider" }).click();
  for (const key of ["grok", "fx", "muse"]) await expect(main(page).locator(`[data-catalog-item="${key}"]`)).toBeVisible();
});

test("on/off in the header sends set_provider_instance; a provider switched off stays listed as Off", async ({ page }) => {
  await page.goto("/?fake=1PBB-2");
  await row(page, "cursor").click();
  await main(page).getByRole("switch", { name: "Cursor on" }).click();
  await expect(row(page, "cursor")).toHaveText("CursorOff");
  expect(await sent(page, "set_provider_instance")).toEqual([expect.objectContaining({ instanceId: "cursor", driver: "cursor", enabled: false })]);
  await main(page).getByRole("switch", { name: "Cursor on" }).click();
  await expect(row(page, "cursor")).toHaveText("CursorReady · Cursor account");
});

test("sign-in: Sign in starts the browser flow; when it finishes the account shows", async ({ page }) => {
  await page.goto("/?fake=2LET-2");
  await page.evaluate(() => { window.open = () => null; });
  await main(page).getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(main(page).getByText("Finish signing in in your browser.")).toBeVisible();
  expect(await sent(page, "provider_auth_start")).toEqual([expect.objectContaining({ instanceId: "claudeAgent" })]);
  await expect(row(page, "claudeAgent")).toHaveText("ClaudeSigning in");
  await page.evaluate(() => (window as unknown as { __goat2FakeProviders: { completeAuth(id: string): void } }).__goat2FakeProviders.completeAuth("claudeAgent"));
  await expect(main(page).getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(row(page, "claudeAgent")).toHaveText(/^ClaudeReady/);
});

test("ACP URL auth: Continue authentication accepts the engine's sign-in link", async ({ page }) => {
  await page.goto("/?fake=1Q0P-2");
  await page.evaluate(() => { window.open = () => null; });
  await expect(main(page)).toContainText("Sign in with Google to see Antigravity limits.");
  await main(page).getByRole("button", { name: "Continue authentication" }).click();
  await expect.poll(() => sent(page, "accept_acp_registry_url_auth")).toEqual([expect.objectContaining({ instanceId: "antigravity", elicitationId: "agy-signin-1" })]);
});

test("ACP URL auth: a link the host no longer accepts is not opened; the reason shows", async ({ page }) => {
  await page.goto("/?fake=1Q0P-2");
  await page.evaluate(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = (url?: string | URL) => { (window as unknown as { __opened: string[] }).__opened.push(String(url)); return null; };
    // The engine replaced its sign-in request; the page still shows the old one.
    type Probe = { auth: { action?: { elicitationId: string } } };
    const fake = (window as unknown as { __goat2FakeProviders: { entries: Array<{ instanceId: string; probe: Probe }> } }).__goat2FakeProviders;
    const e = fake.entries.find((x) => x.instanceId === "antigravity")!; // fake frames share objects with the page: replace, never mutate
    e.probe = { ...e.probe, auth: { ...e.probe.auth, action: { ...e.probe.auth.action!, elicitationId: "agy-signin-2" } } };
  });
  await main(page).getByRole("button", { name: "Continue authentication" }).click();
  await expect(main(page).getByRole("alert")).toHaveText("This sign-in link is no longer valid. Check again to get a new one.");
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([]);
});

test("cloud counterparts are opt-in and off; cloud runs come later", async ({ page }) => {
  await page.goto("/?fake=2LET-2");
  const cloud = main(page).getByLabel("Also run in the cloud");
  await expect(cloud).toContainText("Claude Cloud");
  await expect(cloud.getByRole("switch", { name: "Claude Cloud on" })).toBeDisabled();
  await expect(cloud.getByRole("switch", { name: "Claude Cloud on" })).toHaveAttribute("aria-checked", "false");
});

test("catalog: Add an installed provider, Install and add a missing one, install two registry agents", async ({ page }) => {
  await page.goto("/?fake=1QAN-2");
  const item = (key: string) => main(page).locator(`[data-catalog-item="${key}"]`);
  await expect(item("codex")).toContainText("Already added: 2 accounts.");
  await item("grok").getByRole("button", { name: "Add" }).click();
  await expect(row(page, "grok")).toHaveText("GrokReady · SuperGrok");
  await expect(main(page).getByRole("heading")).toHaveText("Grok");
  await sidebar(page).getByRole("button", { name: "Add a provider" }).click();
  await item("muse").getByRole("button", { name: "Install and add" }).click();
  await expect(row(page, "muse")).toContainText("Installing");
  expect(await sent(page, "provider_install_start")).toEqual([expect.objectContaining({ instanceId: "muse" })]);
  for (const [id, name] of [["kiro", "Kiro CLI"], ["qwen-code", "Qwen Code"]] as const) {
    await sidebar(page).getByRole("button", { name: "Add a provider" }).click();
    await main(page).getByLabel("Search providers and agents").fill(name.split(" ")[0]!);
    await item(`acp:${id}`).getByRole("button", { name: "Install and add" }).click();
    await expect(row(page, `acp-${id}`)).toContainText(name);
  }
  expect((await sent(page, "prepare_acp_registry_agent")).map((f) => f.agentId)).toEqual(["kiro", "qwen-code"]);
  expect(await sent(page, "set_provider_instance")).toEqual([
    expect.objectContaining({ instanceId: "grok", enabled: true }), expect.objectContaining({ instanceId: "muse", enabled: true }),
    expect.objectContaining({ instanceId: "acp-kiro", driver: "acpRegistry", acpAgentId: "kiro", enabled: true }),
    expect.objectContaining({ instanceId: "acp-qwen-code", driver: "acpRegistry", acpAgentId: "qwen-code", enabled: true }),
  ]);
  await sidebar(page).getByRole("button", { name: "Add a provider" }).click();
  await main(page).getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(item("devinCloud").getByRole("button", { name: "Add" })).toBeDisabled();
});

test("another account: a separate Codex instance (own home on the host); other drivers wait; repair is one provider command", async ({ page }) => {
  await page.goto("/?fake=1PBB-2");
  await main(page).getByRole("button", { name: "Add another account" }).click();
  await expect(row(page, "codex-3")).toContainText("Codex · Account 3");
  expect(await sent(page, "set_provider_instance")).toEqual([expect.objectContaining({ instanceId: "codex-3", driver: "codex", enabled: true, displayName: "Account 3" })]);
  await row(page, "claudeAgent").click();
  await expect(main(page).getByRole("button", { name: "Add another account" })).toBeDisabled();
  await expect(main(page)).toContainText("Separate Claude accounts come with a later GOAT 2 update.");
  await row(page, "omo").click();
  await expect(main(page)).toContainText("OmO can’t start: runtime target missing.");
  await main(page).getByRole("button", { name: "Reinstall" }).click();
  expect(await sent(page, "provider_install_start")).toEqual([expect.objectContaining({ instanceId: "omo" })]);
});

test("Remove from list: a registry agent is switched off and leaves the list; adding it again brings it back", async ({ page }) => {
  await page.goto("/?fake=1PBB-2");
  await row(page, "acp-kimi-code").click();
  await main(page).getByRole("button", { name: "More" }).click();
  await main(page).getByRole("menuitem", { name: "Remove from list" }).click();
  await expect(row(page, "acp-kimi-code")).toHaveCount(0);
  expect(await sent(page, "set_provider_instance")).toEqual([expect.objectContaining({ instanceId: "acp-kimi-code", enabled: false })]);
  await sidebar(page).getByRole("button", { name: "Add a provider" }).click();
  await main(page).locator('[data-catalog-item="acp:kimi-code"]').getByRole("button", { name: "Install and add" }).click();
  await expect(row(page, "acp-kimi-code")).toBeVisible();
});

test("keyboard: provider controls show a focus ring", async ({ page }) => {
  await page.goto("/?fake=1PBB-2");
  await row(page, "codex").focus();
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).toBe("solid");
});

test("first run: lists what is on this Mac; Add all adds them", async ({ page }) => {
  await page.goto("/?fake=2LEV-2");
  await expect(main(page)).toContainText("No providers yet");
  await expect(main(page)).toContainText("Installed · signed in as y•••@example.com");
  await main(page).getByRole("button", { name: "Add all 3" }).click();
  await expect(row(page, "codex")).toBeVisible();
  await expect(row(page, "claudeAgent")).toBeVisible();
  await expect(row(page, "cursor")).toBeVisible();
  expect((await sent(page, "set_provider_instance")).map((f) => f.instanceId)).toEqual(["codex", "claudeAgent", "cursor"]);
});

test("composer picker: picking a model and a reasoning level changes the bot thread for its next turn", async ({ page }) => {
  await page.goto("/?fake=2R-1");
  await page.getByRole("button", { name: "Reviewer model: gpt-6.1-sol" }).click();
  const picker = page.getByRole("dialog", { name: "Choose a model" });
  await expect(picker).toContainText("Claude and Antigravity need sign-in.");
  await picker.getByRole("button", { name: "GPT-6.1 Terra", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reviewer model: gpt-6.1-terra" })).toBeVisible();
  expect(await sent(page, "change_thread")).toEqual([expect.objectContaining({ threadId: "t-reviewer", modelSelection: { instanceId: "codex", model: "gpt-6.1-terra" } })]);
  await page.getByRole("button", { name: "Reviewer model: gpt-6.1-terra" }).click();
  await picker.getByRole("button", { name: "Medium", exact: true }).click();
  await expect.poll(async () => (await sent(page, "change_thread")).at(-1)).toEqual(expect.objectContaining({
    modelSelection: { instanceId: "codex", model: "gpt-6.1-terra", options: [{ id: "reasoningEffort", value: "medium" }] } }));
  await picker.getByRole("button", { name: "Add GPT-6 Luna to favorites" }).click();
  await picker.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(picker.getByRole("listitem")).toHaveCount(1);
  await picker.getByRole("button", { name: "Open Providers" }).click();
  await expect(main(page).getByRole("heading")).toHaveText("Claude");
});

test("bot settings: the same picker changes the main bot's model", async ({ page }) => {
  await page.goto("/?fake=1QYE-2");
  await page.getByRole("button", { name: "GOAT model: gpt-6.1-sol" }).click();
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: "GPT-6 Luna", exact: true }).click();
  await expect(page.getByRole("button", { name: "GOAT model: gpt-6-luna" })).toBeVisible();
  expect(await sent(page, "change_thread")).toEqual([expect.objectContaining({ threadId: "t-main", modelSelection: { instanceId: "codex", model: "gpt-6-luna" } })]);
});

test("thread view: the composer picker changes the open thread's model; a new thread starts on the picked model", async ({ page }) => {
  await page.goto("/?fake=1NEM-1");
  await page.getByRole("button", { name: /model: gpt-6\.1-sol$/ }).click();
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: "GPT-6.1 Terra", exact: true }).click();
  expect(await sent(page, "change_thread")).toEqual([expect.objectContaining({ threadId: "t-billing", modelSelection: { instanceId: "codex", model: "gpt-6.1-terra" } })]);
  await page.getByRole("button", { name: "New thread" }).first().click();
  await page.getByRole("button", { name: "New thread model: gpt-6.1-sol" }).click();
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: "GPT-6 Luna", exact: true }).click();
  await expect(page.getByRole("button", { name: "New thread model: gpt-6-luna" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("hello");
  await page.keyboard.press("Enter");
  await expect.poll(() => sent(page, "start_thread")).toEqual([expect.objectContaining({ modelSelection: { instanceId: "codex", model: "gpt-6-luna" } })]);
});

test("bot panel edit opens the bot's settings page", async ({ page }) => {
  await page.goto("/?fake=2R-1");
  await page.getByRole("button", { name: "Reviewer settings" }).click();
  await expect(page.locator("[data-bot-settings]")).toContainText("Reviewer");
});

