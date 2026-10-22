import { act, useSyncExternalStore, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/" }),
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
  useMarkGoatBotRead: () => null,
}));

import { publishSidebarPriorityCount } from "../Sidebar.logic";
import {
  SidebarBrandWidthProbe,
  SidebarChromeHeader,
  SidebarCollapsedBrand,
} from "./SidebarChrome";

const brandState = vi.hoisted(() => ({
  channel: "stable" as "stable" | "dev" | "nightly",
  mode: "pill" as "pill" | "none",
}));
vi.mock("./brandChannel", () => ({ useBrandChannel: () => brandState.channel }));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useEnvironmentIdentificationMode: () => brandState.mode,
}));
vi.mock("../ui/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/sidebar")>()),
  SidebarTrigger: () => <button aria-label="Toggle main sidebar" />,
}));
vi.mock("./SidebarViewToggles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SidebarViewToggles")>()),
  SidebarViewToggles: () => null,
}));

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  botState.count = undefined;
  brandState.channel = "stable";
  brandState.mode = "pill";
  publishSidebarPriorityCount(0);
});

afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = undefined;
  publishSidebarPriorityCount(null);
  vi.unstubAllGlobals();
});

async function renderBrand(visible: boolean) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => {
    root?.render(<SidebarCollapsedBrand visible={visible} onWidthChange={() => {}} />);
  });
}

it("renders the GOAT wordmark as plain text named GOAT for assistive technology", async () => {
  await renderBrand(false);
  const logotype = container.querySelector('[role="img"][aria-label="GOAT"]');
  expect(logotype?.textContent?.trim()).toBe("GOAT");
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

it("keeps the waiting badge in both width probes, with the wordmark in both", async () => {
  await renderBrand(false);
  await act(() =>
    root?.render(
      <>
        <SidebarBrandWidthProbe onWidthChange={() => {}} />
        <SidebarCollapsedBrand visible={false} onWidthChange={() => {}} />
      </>,
    ),
  );
  expect(container.textContent?.trim()).toBe("GOATGOAT");
  await act(() => setCount(101));
  await act(() =>
    root?.render(
      <>
        <SidebarBrandWidthProbe onWidthChange={() => {}} />
        <SidebarCollapsedBrand visible={false} onWidthChange={() => {}} />
      </>,
    ),
  );
  expect(container.textContent?.trim()).toBe("GOAT101GOAT101");
  await act(() => setCount(undefined));
  await act(() =>
    root?.render(
      <>
        <SidebarBrandWidthProbe onWidthChange={() => {}} />
        <SidebarCollapsedBrand visible={false} onWidthChange={() => {}} />
      </>,
    ),
  );
  expect(container.textContent?.trim()).toBe("GOATGOAT");
});

it("updates the width probe badge when Priority gains, changes and loses threads", async () => {
  await renderBrand(false);
  await act(() => root?.render(<SidebarBrandWidthProbe onWidthChange={() => {}} />));
  expect(container.textContent).toBe("GOAT");
  await act(() => publishSidebarPriorityCount(9));
  expect(container.textContent).toBe("GOAT9");
  await act(() => publishSidebarPriorityCount(101));
  expect(container.textContent).toBe("GOAT101");
  await act(() => publishSidebarPriorityCount(0));
  expect(container.textContent).toBe("GOAT");
});

it.each([
  ["dev", "pill", "Dev"],
  ["nightly", "pill", "Nightly"],
  ["dev", "none", null],
  ["stable", "pill", null],
] as const)("shows %s in %s mode outside the expanded probe", async (channel, mode, label) => {
  brandState.channel = channel;
  brandState.mode = mode;
  await renderBrand(false);
  await act(() =>
    root?.render(
      <>
        <div data-placement="expanded">
          <SidebarChromeHeader isElectron />
        </div>
        <div data-placement="collapsed">
          <SidebarCollapsedBrand visible onWidthChange={() => {}} />
        </div>
        <div data-placement="expanded-probe">
          <SidebarBrandWidthProbe onWidthChange={() => {}} />
        </div>
        <div data-placement="collapsed-probe">
          <SidebarCollapsedBrand visible={false} onWidthChange={() => {}} />
        </div>
      </>,
    ),
  );
  const placements = container.querySelectorAll("[data-placement]");
  expect(placements).toHaveLength(4);
  for (const placement of placements) {
    const pill = placement.querySelector('[data-environment-identification="pill"]');
    const expectedLabel =
      placement.getAttribute("data-placement") === "expanded-probe" ? null : label;
    expect(pill?.textContent ?? null).toBe(expectedLabel);
    expect(placement.querySelector('[aria-label="GOAT"]')?.textContent?.trim()).toBe("GOAT");
  }
  for (const placement of Array.from(placements).slice(0, 2)) {
    const pill = placement.querySelector('[data-environment-identification="pill"]');
    if (pill) {
      expect(pill.closest('[aria-hidden="true"]')).toBeNull();
      expect(pill.closest('[class*="no-drag"]')).toBeNull();
    }
  }
  const expandedHeader = placements[0]?.firstElementChild;
  expect(expandedHeader?.classList.contains("drag-region")).toBe(true);
  expect(expandedHeader?.firstElementChild?.matches('span[aria-hidden="true"]')).toBe(
    label !== null,
  );
  expect(placements[1]?.querySelector('span[aria-hidden="true"].h-0\\.5')).toBeNull();
});
