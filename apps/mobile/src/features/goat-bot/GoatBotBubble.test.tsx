import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const appearance = vi.hoisted(() => ({ mode: "light" as "light" | "dark" }));

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: appearance.mode }),
}));

vi.mock("react-native", () => ({
  View: ({ style, children }: { style?: unknown; children?: ReactNode }) => (
    <div data-style={JSON.stringify(style)}>{children}</div>
  ),
  Text: ({ style, children }: { style?: unknown; children?: ReactNode }) => (
    <span data-style={JSON.stringify(style)}>{children}</span>
  ),
}));

vi.mock("react-native-svg", () => ({
  default: ({ style, children }: { style?: unknown; children?: ReactNode }) => (
    <div data-testid="goat-bubble-tail" data-style={JSON.stringify(style)}>
      {children}
    </div>
  ),
  Path: ({ fill }: { fill: string }) => (
    <div data-testid="goat-bubble-tail-path" data-fill={fill} />
  ),
}));

import { GoatBotBubble, GoatBotTypingIndicator } from "./GoatBotBubble";

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  appearance.mode = "light";
});

async function renderBubble(side: "in" | "out", tail: boolean) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <GoatBotBubble side={side} tail={tail}>
        Message
      </GoatBotBubble>,
    ),
  );
  const bubble = container.firstElementChild;
  if (!bubble) throw new Error("Expected GOAT Bot bubble");
  return bubble;
}

const styleOf = (element: Element) => JSON.parse(element.getAttribute("data-style") ?? "null");

it.each([
  ["light", "out", "#1466D0"],
  ["dark", "out", "#2B66C6"],
  ["light", "in", "#E9E9EB"],
  ["dark", "in", "#3A3A3C"],
] as const)("uses %s appearance for the %s bubble", async (mode, side, color) => {
  appearance.mode = mode;
  const bubble = await renderBubble(side, true);
  expect(styleOf(bubble).backgroundColor).toBe(color);
  expect(styleOf(bubble)).toMatchObject({
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 13,
  });
  expect(
    bubble.querySelector('[data-testid="goat-bubble-tail-path"]')?.getAttribute("data-fill"),
  ).toBe(color);
});

it("shows a tail only when requested, on the side of its bubble", async () => {
  let bubble = await renderBubble("out", false);
  expect(bubble.querySelector('[data-testid="goat-bubble-tail"]')).toBeNull();
  await act(async () => root.unmount());
  container.remove();

  bubble = await renderBubble("out", true);
  const outgoingTail = bubble.querySelector('[data-testid="goat-bubble-tail"]');
  expect(outgoingTail).not.toBeNull();
  expect(styleOf(outgoingTail!).right).toBe(-8);
  expect(styleOf(outgoingTail!).left).toBeUndefined();
  await act(async () => root.unmount());
  container.remove();

  bubble = await renderBubble("in", true);
  const incomingTail = bubble.querySelector('[data-testid="goat-bubble-tail"]');
  expect(incomingTail).not.toBeNull();
  expect(styleOf(incomingTail!).left).toBe(-8);
  expect(styleOf(incomingTail!).right).toBeUndefined();
});

it("renders the typing dots inside an incoming bubble with its tail", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<GoatBotTypingIndicator />));

  const bubble = container.firstElementChild?.firstElementChild;
  const dots = bubble?.firstElementChild;
  expect(bubble).not.toBeNull();
  expect(styleOf(bubble!).backgroundColor).toBe("#E9E9EB");
  expect(styleOf(dots!).minHeight).toBe(40);
  expect(dots?.children).toHaveLength(3);
  for (const dot of Array.from(dots?.children ?? [])) {
    expect(styleOf(dot)).toMatchObject({ width: 7, height: 7, backgroundColor: "#000000" });
  }
  const tail = bubble?.querySelector('[data-testid="goat-bubble-tail"]');
  expect(styleOf(tail!).left).toBe(-8);
});
