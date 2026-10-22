import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  type ProviderHostMatrixResult,
  type ProviderSyncState,
} from "@goat/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { fakeTimers } from "../../../test/render";

const commands = vi.hoisted(() => ({
  matrix: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock(import("./ProviderHostMatrix.commands"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    readProviderHostMatrix: { run: commands.matrix },
    startProviderHostSync: { run: commands.start, permissionAtom: () => allowed },
    readProviderHostSync: { run: commands.status },
    cancelProviderHostSync: { run: commands.cancel, permissionAtom: () => allowed },
  } as never;
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { run: unknown }) => command.run,
}));

import { ProviderHostSyncDialog } from "./ProviderHostSyncDialog";

const environmentId = EnvironmentId.make("provider-host-sync-environment");
const matrix = {
  rows: [
    { host: "lidge", status: "ok", providers: [] },
    { host: "mini", status: "update_runtime", providers: [] },
  ],
} satisfies ProviderHostMatrixResult;
const sync = {
  syncId: "opencode-sync-1",
  driver: "opencode",
  version: null,
  login: true,
  startedAt: "2026-10-20T00:00:00.000Z",
  done: false,
  hosts: [{ host: "lidge", phase: "installing", version: null }],
} satisfies ProviderSyncState;
const loginUrl = "https://auth.openai.com/codex/device";

let root: Root;
let container: HTMLDivElement;
let wasDark: boolean;

beforeEach(async () => {
  await page.viewport(1280, 900);
  wasDark = document.documentElement.classList.contains("dark");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.matrix.mockReset().mockResolvedValue({ _tag: "Success", value: matrix });
  commands.start.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { kind: "started", sync },
  });
  commands.status
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        ...sync,
        hosts: [
          {
            host: "lidge",
            phase: "signing_in",
            version: "1.0.0",
            login: { type: "device_code", url: loginUrl, userCode: "ABCD-12345" },
          },
        ],
      } satisfies ProviderSyncState,
    })
    .mockResolvedValue({
      _tag: "Success",
      value: {
        ...sync,
        done: true,
        hosts: [{ host: "lidge", phase: "signed_in", version: "1.0.0" }],
      } satisfies ProviderSyncState,
    });
  commands.cancel.mockReset();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.documentElement.classList.toggle("dark", wasDark);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["light", "dark"] as const)(
  "syncs OpenCode to an eligible machine, shows device sign-in, and stops polling on success (%s)",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await act(async () => {
      root.render(
        <RegistryProvider>
          <ProviderHostSyncDialog
            environmentId={environmentId}
            driver="opencode"
            displayName="OpenCode"
            open
            onOpenChange={() => {}}
          />
        </RegistryProvider>,
      );
    });

    const dialog = page.getByRole("dialog", { name: "Sync OpenCode" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog.getByRole("checkbox", { name: "lidge", exact: true }))
      .toBeChecked();
    const mini = dialog.getByRole("checkbox", { name: /^mini/ });
    await expect.element(mini).toBeDisabled();
    await expect.element(mini).not.toBeChecked();
    await expect.element(dialog.getByText("Update runtime", { exact: true })).toBeVisible();
    expect(commands.matrix).toHaveBeenCalledWith({ environmentId, input: {} });

    using _timers = fakeTimers();
    await act(async () => {
      const start = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
      ].find((button) => button.textContent === "Start");
      expect(start).toBeDefined();
      start!.click();
    });
    expect(commands.start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { driver: "opencode", hosts: ["lidge"], version: "latest", login: true },
    });
    expect(commands.status).not.toHaveBeenCalled();
    await expect.element(dialog.getByText("Installing", { exact: true })).toBeVisible();

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(commands.status).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { syncId: sync.syncId },
    });
    await expect.element(dialog.getByText("ABCD-12345", { exact: true })).toBeVisible();
    const link = dialog.getByRole("link", { name: loginUrl });
    await expect.element(link).toBeVisible();
    await expect.element(link).toHaveAttribute("href", loginUrl);

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await expect.element(dialog.getByText("Signed in", { exact: true })).toBeVisible();
    await expect.element(dialog.getByRole("status")).toHaveTextContent("1 of 1 machines synced.");
    await expect.element(dialog.getByRole("button", { name: "Sync again" })).toBeEnabled();
    await expect.element(dialog.getByText("ABCD-12345", { exact: true })).not.toBeInTheDocument();
    expect(commands.status).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(commands.status).toHaveBeenCalledTimes(2);
  },
);
