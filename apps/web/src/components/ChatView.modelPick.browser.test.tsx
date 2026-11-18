import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import type { OrchestrationV2Command } from "@goat/contracts";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";
import { useComposerDraftStore } from "~/composerDraftStore";
import { scopeThreadRef } from "@goat/client-runtime/environment";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (original) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    original<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("sends the picked model while its thread selection save is pending", async () => {
  const thread = threadWithHistory("thread-model-pick", 1);
  const commands: OrchestrationV2Command[] = [];
  let releaseSave: (result: { sequence: number }) => void = () => {};
  const pendingSave = new Promise<{ sequence: number }>((resolve) => {
    releaseSave = resolve;
  });
  using _environment = installFakeEnvironment([thread], {
    capabilities: { serverResolvedCommandContext: true },
    models: [
      { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
      { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    ],
    onCommand: async (command) => {
      commands.push(command);
      return command.type === "thread.model-selection.set" ? pendingSave : { sequence: 2 };
    },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("Answer 0 for thread-model-pick.")).toBeVisible();
  await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
  await page.getByRole("option", { name: /GPT-5\.5/ }).click();
  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, thread.id)),
  ).toMatchObject({
    activeProvider: "codex",
    modelSelectionByProvider: { codex: { model: "gpt-5.5" } },
  });
  await vi.waitFor(() =>
    expect(commands.some((command) => command.type === "thread.model-selection.set")).toBe(true),
  );
  await page.getByTestId("composer-editor").click();
  await userEvent.keyboard("Send immediately");
  await userEvent.keyboard("{Enter}");
  releaseSave({ sequence: 2 });
  await vi.waitFor(() =>
    expect(commands.some((command) => command.type === "message.dispatch")).toBe(true),
  );
  expect(commands.find((command) => command.type === "message.dispatch")).toMatchObject({
    modelSelection: { instanceId: "codex", model: "gpt-5.5" },
  });
  // Unmount only once the sent message renders, so no import the send started is still
  // loading through the mocked driver's route when the next file takes the page.
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="composer-editor"]')?.textContent?.trim()).toBe("");
    const sent = [...document.querySelectorAll('[data-message-role="user"]')].map(
      (row) => row.textContent ?? "",
    );
    expect(sent.some((text) => text.includes("Send immediately"))).toBe(true);
  });
});

it("shows a busy toast and does not dispatch a second message while sending", async () => {
  const thread = threadWithHistory("thread-busy-send", 1);
  const commands: OrchestrationV2Command[] = [];
  let releaseSend: (result: { sequence: number }) => void = () => {};
  const pendingSend = new Promise<{ sequence: number }>((resolve) => {
    releaseSend = resolve;
  });
  using _environment = installFakeEnvironment([thread], {
    capabilities: { serverResolvedCommandContext: true },
    onCommand: async (command) => {
      commands.push(command);
      return command.type === "message.dispatch" ? pendingSend : { sequence: 2 };
    },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("Answer 0 for thread-busy-send.")).toBeVisible();
  await page.getByTestId("composer-editor").click();
  await userEvent.keyboard("First message{Enter}");
  await vi.waitFor(() =>
    expect(commands.filter((command) => command.type === "message.dispatch")).toHaveLength(1),
  );
  await page.getByTestId("composer-editor").click();
  await userEvent.keyboard("Second message{Enter}");
  await expect.element(page.getByText("Still sending your previous message.")).toBeVisible();
  expect(commands.filter((command) => command.type === "message.dispatch")).toHaveLength(1);
  releaseSend({ sequence: 2 });
});
