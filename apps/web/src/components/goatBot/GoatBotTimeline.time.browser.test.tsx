import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({ usePrimarySettings: () => "system" }));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => <div>Work card</div> }));

import { GoatBotTimeline } from "./GoatBotTimeline";

let root: Root;
let container: HTMLDivElement;
const createdAt = "2026-10-12T09:40:00Z";
const user = (id: string, failed = false): GoatBotRow => ({
  kind: "user",
  sendKey: null,
  requestKey: null,
  id,
  text: id,
  createdAt,
  firstInGroup: true,
  groupPosition: "single",
  delivery: failed ? { state: "failed", clientKey: id } : { state: "sent" },
  showReceipt: false,
});
const bot: GoatBotRow = {
  kind: "bot",
  id: "bot",
  text: "Reply",
  createdAt,
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
};
const task: GoatBotRow = {
  kind: "task",
  id: "task",
  createdAt,
  firstInGroup: true,
  groupPosition: "single",
  card: {
    key: "task",
    revision: 1,
    updatedAt: createdAt,
    title: "Work",
    statusLabel: "Running",
    tone: "active",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "none", label: "Unavailable" },
  },
};

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

it("links each sent user and bot message to its own time slot, excluding failed sends and task cards", async () => {
  await act(() =>
    root.render(
      <GoatBotTimeline rows={[user("sent"), user("failed", true), bot, task]} onRetry={() => {}} />,
    ),
  );
  const messages = [...container.querySelectorAll("li[aria-describedby]")];
  expect(messages).toHaveLength(2);
  for (const message of messages) {
    const timeId = message.getAttribute("aria-describedby");
    const time = [...message.querySelectorAll("time")].find((item) => item.id === timeId);
    expect(message.getAttribute("tabindex")).toBe("0");
    expect(time?.dateTime).toBe(createdAt);
    expect(time?.className).toContain("max-[360px]:sr-only");
  }
  const failed = [...container.querySelectorAll("li")].find((item) =>
    item.textContent?.includes("Not Delivered"),
  );
  expect(failed?.querySelector("time")).toBeNull();
  expect(failed?.hasAttribute("aria-describedby")).toBe(false);
  const card = [...container.querySelectorAll("li")].find((item) =>
    item.textContent?.includes("Work card"),
  );
  expect(card?.querySelector("time")).toBeNull();
  expect(card?.hasAttribute("aria-describedby")).toBe(false);
});

it("updates edge fade flags as the reader scrolls", async () => {
  await act(() => root.render(<GoatBotTimeline rows={[user("sent")]} onRetry={() => {}} />));
  const wrapper = container.querySelector(".goat-timeline") as HTMLDivElement;
  const scroll = wrapper.querySelector(".overflow-y-auto") as HTMLDivElement;
  // Chromium clamps scrollTop to the real layout, regardless of mocked height getters.
  Object.assign(scroll.style, { height: "100px", flex: "none", overflowY: "auto" });
  Object.assign(scroll.querySelector("ol")!.style, {
    height: "300px",
    boxSizing: "border-box",
    margin: "0",
  });
  scroll.scrollTop = 0;
  await act(() => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(wrapper.dataset.atTop).toBe("true");
  expect(wrapper.dataset.atBottom).toBe("false");
  scroll.scrollTop = 200;
  await act(() => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(wrapper.dataset.atTop).toBe("false");
  expect(wrapper.dataset.atBottom).toBe("true");
});
