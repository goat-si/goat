// @vitest-environment jsdom

import { act, useSyncExternalStore, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => "/",
  useParams: () => ({}),
  Link: ({ to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props} />,
}));

const botState = vi.hoisted(() => ({ count: undefined as number | undefined }));
// Stands in for the shared count subscription, so a new count re-renders even memoized JSX.
const countListeners = new Set<() => void>();
function setCount(count: number | undefined) {
  botState.count = count;
  for (const listener of countListeners) listener();
}
vi.mock("../goatBot/useGoatBotWaitingCount", () => ({
  useGoatBotWaitingCount: () =>
    useSyncExternalStore(
      (listener) => {
        countListeners.add(listener);
        return () => countListeners.delete(listener);
      },
      () => botState.count,
    ),
}));

import { SidebarCollapsedBrand } from "./SidebarChrome";

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  botState.count = undefined;
});

afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

async function renderBrand(visible: boolean) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => {
    root?.render(<SidebarCollapsedBrand visible={visible} onWidthChange={() => {}} />);
  });
}

it("renders the brand text as uppercase GOAT in the brand font", async () => {
  await renderBrand(false);
  const text = container.querySelector(".font-brand");
  expect(text?.textContent?.trim()).toBe("GOAT");
  expect(text?.classList.contains("font-bold")).toBe(true);
});

it("renders a non-interactive measurement copy while the sidebar is expanded", async () => {
  await renderBrand(false);
  const wrapper = container.querySelector("[data-collapsed-brand]");
  expect(wrapper?.classList.contains("invisible")).toBe(true);
  expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelector("a, button, [tabindex]")).toBeNull();
  expect(container.querySelector('[class*="no-drag"]')).toBeNull();
  expect(container.textContent?.trim()).toBe("GOAT");
});

it("renders the no-drag global agent link while the sidebar is collapsed", async () => {
  await renderBrand(true);
  const link = container.querySelector("a");
  expect(link?.getAttribute("href")).toBe("/");
  expect(link?.getAttribute("aria-label")).toBe("Open global agent");
  expect(link?.classList.contains("pointer-events-auto")).toBe(true);
  expect(link?.classList.contains("[-webkit-app-region:no-drag]")).toBe(true);
  link?.focus();
  expect(document.activeElement).toBe(link);
  expect(container.querySelector("[data-collapsed-brand]")?.getAttribute("aria-hidden")).toBe(
    "false",
  );
});

it("keeps the waiting badge in the measured brand as the count changes", async () => {
  await renderBrand(false);
  expect(container.textContent?.trim()).toBe("GOAT");
  await act(() => setCount(101));
  expect(container.textContent?.trim()).toBe("GOAT101");
  await act(() => setCount(undefined));
  expect(container.textContent?.trim()).toBe("GOAT");
});
