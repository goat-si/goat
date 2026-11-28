// Provider surfaces on the fake host (Part 2, lane P2-M): the lifted v1 screens over the approved provider frames
// (docs/part2/provider-wire.md). Boards: 1PBB-2 list, 1Q0P-2 sign-in, 1QAN-2 registry, 1QM8-2 / 1QYE-2 pickers.
import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

const sent = (page: Page, type: string) =>
  page.evaluate((t) => (window as unknown as { __goat2Fake: { received: Array<Record<string, unknown>> } }).__goat2Fake.received.filter((f) => f.type === t), type);
const settings = (page: Page) => page.locator("[data-settings-main]");

test("Settings > Providers lists every local v1 provider kind with its state", async ({ page }) => {
  await page.goto("/?fake=1PBB-2");
  const main = settings(page);
  const rows: Array<[string, RegExp]> = [
    ["Codex", /v0\.167\.0[\s\S]*Authenticated/], ["Claude", /v2\.1\.332[\s\S]*Not authenticated/],
    ["Grok", /Not found · grok was not found on PATH/], ["fx", /Not found · fx was not found on PATH/],
    ["Antigravity", /Not authenticated · Sign in with Google/], ["OpenCode", /v1\.19\.4[\s\S]*Authenticated/],
    ["Cursor", /Authenticated · Cursor account/], ["Muse Code", /Not found · Muse is not installed/],
    ["Pi", /v0\.42\.0[\s\S]*Authenticated/], ["OmO", /Unavailable · Runtime target missing/],
    ["Kimi Code", /v2\.8\.1[\s\S]*Authenticated/], ["Kilo", /Needs attention · Updating to 7\.8\.32/],
  ];
  for (const [name, state] of rows) {
    const row = main.getByRole("button", { name: `Select ${name}`, exact: true }).locator("xpath=..");
    await expect(row, name).toContainText(state);
  }
  // Cloud defaults are Part 3: shown switched off, never "waiting for the server".
  await expect(main.getByRole("button", { name: "Select Claude Cloud", exact: true }).locator("xpath=..")).toContainText("Disabled");
});

test("sign-in: Sign in starts the flow with the AuthRequired URL, a finished sign-in shows the account", async ({ page }) => {
  await page.goto("/?fake=1Q0P-2");
  await page.getByRole("button", { name: "Select Antigravity", exact: true }).click();
  const main = settings(page);
  await expect(main.getByText("https://accounts.google.com/o/oauth2/v2/auth?client_id=antigravity-demo")).toBeVisible();
  await main.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(main.getByText("Finish signing in in your browser.")).toBeVisible();
  expect(await sent(page, "provider_auth_start")).toEqual([expect.objectContaining({ instanceId: "antigravity" })]);
  await page.evaluate(() => (window as unknown as { __goat2FakeProviders: { completeAuth(id: string): void } }).__goat2FakeProviders.completeAuth("antigravity"));
  await expect(main.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("ACP registry: search, add an agent through v1's wizard, it joins the list", async ({ page }) => {
  await page.goto("/?fake=1QAN-2");
  await settings(page).getByRole("button", { name: "Add provider" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("Search agents…").fill("ki");
  await expect(dialog.getByRole("button", { name: "Add Kiro CLI" })).toBeVisible();
  await expect(dialog.getByText("Added")).toHaveCount(2); // Kimi Code and Kilo are instances already
  await dialog.getByRole("button", { name: "Add Kiro CLI" }).click();
  await dialog.getByRole("button", { name: "Add and set up" }).click();
  await expect(dialog.getByText("Sign in on This Mac.")).toBeVisible();
  expect(await sent(page, "prepare_acp_registry_agent")).toEqual([expect.objectContaining({ agentId: "kiro" })]);
  expect(await sent(page, "set_provider_instance")).toEqual([expect.objectContaining({ driver: "acpRegistry", acpAgentId: "kiro", enabled: true })]);
  await dialog.getByRole("button", { name: "Skip for now" }).click();
  await expect(settings(page).getByRole("button", { name: "Select Kiro CLI", exact: true })).toBeVisible();
});

test("composer chip: the picker changes the bot thread's model for its next turn", async ({ page }) => {
  await page.goto("/?fake=2R-1");
  await page.getByRole("button", { name: "Reviewer model: gpt-6.1-sol" }).click();
  await page.getByText("GPT-6.1 Terra", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Reviewer model: gpt-6.1-terra" })).toBeVisible();
  expect(await sent(page, "change_thread")).toEqual([expect.objectContaining({ threadId: "t-reviewer", modelSelection: { instanceId: "codex", model: "gpt-6.1-terra" } })]);
});

test("Settings > GOAT Bot: the same picker changes the main bot's model", async ({ page }) => {
  await page.goto("/?fake=1QYE-2");
  await page.getByRole("button", { name: "GOAT model: gpt-6.1-sol" }).click();
  await page.getByText("GPT-6 Luna", { exact: true }).click();
  await expect(page.getByRole("button", { name: "GOAT model: gpt-6-luna" })).toBeVisible();
  expect(await sent(page, "change_thread")).toEqual([expect.objectContaining({ threadId: "t-main", modelSelection: { instanceId: "codex", model: "gpt-6-luna" } })]);
});

test("settings nav (v1 SettingsSidebarNav): sections move the GOAT 2 settings page; unbuilt ones say so", async ({ page }) => {
  await page.goto("/?fake=1PBB-2");
  const nav = page.locator("[data-settings-nav]");
  await nav.getByText("GOAT Bot", { exact: true }).click();
  await expect(settings(page)).toContainText("GOAT Bot answers your messages and starts work for you.");
  await nav.getByText("General", { exact: true }).click();
  await expect(settings(page)).toContainText("Planned");
  await nav.getByText("Providers", { exact: true }).click();
  await expect(settings(page).getByRole("button", { name: "Select Codex", exact: true })).toBeVisible();
});
