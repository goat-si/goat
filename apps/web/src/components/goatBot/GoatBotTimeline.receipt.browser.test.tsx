import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({ usePrimarySettings: () => "system" }));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotTimeline } from "./GoatBotTimeline";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const user = (
  id: string,
  delivery: Extract<GoatBotRow, { kind: "user" }>["delivery"],
  showReceipt: boolean,
): GoatBotRow => ({
  kind: "user",
  sendKey: null,
  requestKey: null,
  id,
  text: id,
  createdAt: "2026-10-12T09:40:00Z",
  firstInGroup: true,
  groupPosition: "single",
  delivery,
  showReceipt,
});

it("shows one read receipt under the newest sent bubble", async () => {
  const rows = [
    user("old", { state: "read", readAt: "2026-10-12T09:40:00Z" }, false),
    user("new", { state: "read", readAt: "2026-10-12T09:41:00Z" }, true),
  ];
  await act(() => root.render(<GoatBotTimeline rows={rows} onRetry={() => {}} />));
  expect(container.querySelectorAll("[aria-label^='Read by GOAT Bot']")).toHaveLength(1);
  expect(container.querySelector("li:last-child")?.textContent).toContain("Read");
});

it("keeps an older failed send actionable, but never retries a final rejection", async () => {
  const retry = vi.fn();
  const rows = [
    user("failed", { state: "failed", clientKey: "k" }, false),
    user(
      "rejected",
      { state: "failed", clientKey: "r", rejectionReason: "Account is not linked" },
      false,
    ),
    user("latest", { state: "sending" }, true),
  ];
  await act(() => root.render(<GoatBotTimeline rows={rows} onRetry={retry} />));
  expect(container.textContent).toContain("Not Delivered");
  expect(container.textContent).toContain("Account is not linked");
  const buttons = container.querySelectorAll('button[aria-label="Retry sending"]');
  expect(buttons).toHaveLength(1);
  await act(() => (buttons[0] as HTMLButtonElement).click());
  expect(retry).toHaveBeenCalledWith("k");
});
