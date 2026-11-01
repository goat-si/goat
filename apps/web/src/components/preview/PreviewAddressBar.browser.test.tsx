import { fakeTimers } from "../../../test/render";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { PreviewAddressBar, type PreviewAddressBarProps } from "./PreviewAddressBar";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { useBrowserAddressDraftStore } from "./browserAddressDraftStore";

vi.mock("./PreviewFaviconIcon", () => ({ PreviewFaviconIcon: () => null }));

const ref = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") };
const key = (tab: string, environmentId = ref.environmentId) =>
  previewRuntimeTabId({ ...ref, environmentId }, "epoch", tab);

describe("PreviewAddressBar", () => {
  let root: Root;
  let timers: Disposable;
  let container: HTMLDivElement;
  let props: PreviewAddressBarProps;
  const input = () => container.querySelector<HTMLInputElement>("input")!;
  const render = async () => {
    await act(async () => root.render(<PreviewAddressBar key={props.addressKey} {...props} />));
  };
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(),
        value,
      );
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const press = async (key: string, isComposing = false) => {
    await act(async () => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        isComposing,
      });
      input().dispatchEvent(event);
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersToNextFrame());
  };
  const focus = async () => {
    await act(async () => input().focus());
  };

  beforeEach(() => {
    timers = fakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {},
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    useBrowserAddressDraftStore.setState({ drafts: new Map() });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      addressKey: key("1"),
      threadRef: ref,
      tabId: "1",
      url: "https://example.com/",
      tabs: [{ tabId: "2", url: "https://docs.example.com/", title: "Documentation" }],
      history: [{ url: "https://old.example.com/", title: "Documentation archive" }],
      onSubmit: vi.fn(),
      onActivateTab: vi.fn(() => true),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    timers[Symbol.dispose]();
  });

  it("retains drafts through blur, late URL changes, tab remounts and identical ids in another environment", async () => {
    await render();
    await focus();
    await type("unfinished search");
    await act(async () => input().blur());
    props.url = "https://example.com/redirect";
    await render();
    expect(input().value).toBe("unfinished search");
    props.addressKey = key("2");
    await render();
    expect(input().value).toBe(props.url);
    await focus();
    await type("second tab edit");
    props.addressKey = key("1", EnvironmentId.make("env-2"));
    await render();
    expect(input().value).toBe(props.url);
    props.addressKey = previewRuntimeTabId(
      { ...ref, threadId: ThreadId.make("thread-2") },
      "epoch",
      "1",
    );
    await render();
    expect(input().value).toBe(props.url);
    props.addressKey = key("1");
    await render();
    await focus();
    expect(input().value).toBe("unfinished search");
    await press("Escape");
    expect(input().value).toBe(props.url);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("offers direct search first, navigates options with arrows and activates an existing tab with Enter", async () => {
    await render();
    await focus();
    await type("doc");
    const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options().map((option) => option.textContent)).toEqual([
      expect.stringContaining("Search for “doc”"),
      expect.stringContaining("Switch to tab"),
      expect.stringContaining("Recent"),
    ]);
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowUp");
    await press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
    await press("Enter");
    expect(props.onActivateTab).toHaveBeenCalledExactlyOnceWith("2");
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("chooses recent pages with the mouse and follows subsequent committed redirects", async () => {
    await render();
    await focus();
    await type("archive");
    await act(async () => {
      document.querySelectorAll<HTMLElement>('[role="option"]')[1]!.click();
    });
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("https://old.example.com/");
    props.url = "https://old.example.com/redirect";
    await render();
    expect(input().value).toBe(props.url);
  });

  it.each(["https://example.com/?x=1", "localhost:5173", "new search"])(
    "submits the unhighlighted draft %s with Enter while the popup is open",
    async (target) => {
      await render();
      await focus();
      await type(target);
      expect(input().getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector('[role="option"]')).not.toBeNull();
      expect(input().getAttribute("aria-activedescendant")).toBeNull();

      await press("Enter");

      expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(target);
      expect(props.onActivateTab).not.toHaveBeenCalled();
      expect(input().getAttribute("aria-expanded")).toBe("false");
    },
  );

  it("navigates to the highlighted history item with Enter", async () => {
    await render();
    await focus();
    await type("archive");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(
      document.querySelectorAll('[role="option"]')[1]?.id,
    );

    await press("Enter");

    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("https://old.example.com/");
    expect(props.onActivateTab).not.toHaveBeenCalled();
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores unhighlighted Enter during composition and restores the URL on Escape", async () => {
    await render();
    await focus();
    await type("https://example.com/?x=1");
    await press("Enter", true);
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(input().value).toBe("https://example.com/?x=1");
    expect(input().getAttribute("aria-expanded")).toBe("true");

    await press("Escape");
    expect(input().value).toBe(props.url);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("keeps a draft when a tab result closes before selection", async () => {
    props.onActivateTab = vi.fn(() => false);
    await render();
    await focus();
    await type("doc");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("Enter");
    expect(props.onActivateTab).toHaveBeenCalledWith("2");
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(input().value).toBe("doc");
  });

  it("submits the typed target once and ignores Enter while composing", async () => {
    await render();
    await focus();
    await type("new search");
    await press("ArrowDown");
    await press("Enter", true);
    expect(props.onSubmit).not.toHaveBeenCalled();
    await press("Enter");
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(
      "https://duckduckgo.com/?q=new%20search",
    );
  });

  it("keeps unsupported input editable and respects disabled stream controls", async () => {
    await render();
    await focus();
    await type("ftp://example.com");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(input().value).toBe("ftp://example.com");
    props.disabled = true;
    await render();
    expect(input().disabled).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("submits an unhighlighted draft through the form and dismisses on blur", async () => {
    await render();
    await focus();
    await type("localhost:5173");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("localhost:5173");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    await focus();
    await type("doc");
    await act(async () => input().blur());
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().value).toBe("doc");
  });

  it("does not replay an old focus-address action when switching tabs", async () => {
    const renderChrome = async (nonce: number) => {
      await act(async () =>
        root.render(
          <PreviewChromeRow
            {...props}
            focusUrlNonce={nonce}
            loading={false}
            canGoBack={false}
            canGoForward={false}
            refreshDisabled={false}
            onBack={() => {}}
            onForward={() => {}}
            onRefresh={() => {}}
          />,
        ),
      );
    };
    await renderChrome(1);
    expect(document.activeElement).toBe(input());
    await type("doc");
    props.addressKey = key("2");
    await renderChrome(1);
    expect(document.activeElement).not.toBe(input());
    expect(input().getAttribute("aria-expanded")).toBe("false");
    await renderChrome(2);
    expect(document.activeElement).toBe(input());
  });

  it("bounds ephemeral drafts and clears only the submitted tab's edit", () => {
    const { setDraft } = useBrowserAddressDraftStore.getState();
    for (let i = 0; i < 105; i++) setDraft(`tab-${i}`, `edit-${i}`);
    expect(useBrowserAddressDraftStore.getState().drafts.size).toBe(100);
    expect(useBrowserAddressDraftStore.getState().drafts.has("tab-0")).toBe(false);
    setDraft("tab-104", undefined);
    expect(useBrowserAddressDraftStore.getState().drafts.get("tab-103")).toBe("edit-103");
    expect(useBrowserAddressDraftStore.getState().drafts.has("tab-104")).toBe(false);
  });
});
