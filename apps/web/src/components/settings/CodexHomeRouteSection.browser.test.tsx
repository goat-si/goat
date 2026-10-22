import { EnvironmentId, ProviderInstanceId, DEFAULT_OPENCODEX_BASE_URL } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  ),
}));
import { CodexHomeRouteSection, type CodexHomeRouteSectionProps } from "./CodexHomeRouteSection";

let root: Root;
let container: HTMLDivElement;
const onChange = vi.fn<CodexHomeRouteSectionProps["onChange"]>();
const onRefresh = vi.fn<CodexHomeRouteSectionProps["onRefresh"]>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onChange.mockReset().mockResolvedValue(undefined);
  onRefresh.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(overrides: Partial<CodexHomeRouteSectionProps> = {}) {
  await act(async () =>
    root.render(
      <CodexHomeRouteSection
        environmentId={EnvironmentId.make("vps")}
        environmentLabel="vps-1"
        instanceId={ProviderInstanceId.make("codex_home")}
        readOnly={false}
        settings={{
          setupMode: "existing",
          modelRoute: "opencodex",
          opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
        }}
        onChange={onChange}
        onRefresh={onRefresh}
        onAddInstance={vi.fn()}
        {...overrides}
      />,
    ),
  );
}
function button(label: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label,
  );
}
async function click(label: string, scope: ParentNode = document) {
  const entry = button(label, scope);
  expect(entry, `visible action: ${label}`).toBeDefined();
  await act(async () => entry!.click());
}
function confirmation() {
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog).not.toBeNull();
  return dialog!;
}

describe("OpenCodex Home routing", () => {
  it("hands Connect to the person without changing settings", async () => {
    await render({ status: { modelRoute: "opencodex", state: "not_linked" } });
    await click("Connect to Home");
    expect(container.textContent).toContain(
      "On vps-1, open a terminal and complete OpenCodex's Remote Link setup for this host. Then return here and check status.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });
  it.each(["connected", "home", "reconnecting", "not_running"] as const)(
    "does not offer Connect for %s",
    async (state) => {
      await render({ status: { modelRoute: "opencodex", state } });
      expect(button("Connect to Home")).toBeUndefined();
      if (state === "reconnecting") {
        expect(container.textContent).toContain("Reconnecting to Home…");
        expect(container.textContent).not.toContain("Check OpenCodex and try again.");
      }
    },
  );
  it.each(["not_linked", "failed"] as const)("offers Connect for %s", async (state) => {
    await render({ status: { modelRoute: "opencodex", state } });
    await click("Connect to Home");
    expect(container.textContent).toContain("On vps-1, open a terminal");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("saves default only after confirming that OpenCodex stays linked", async () => {
    await render();
    await click("Stop using OpenCodex Home");
    expect(onChange).not.toHaveBeenCalled();
    expect(confirmation().textContent).toContain(
      "This instance goes back to Codex's own settings. OpenCodex stays connected to Home; run ocx disconnect on vps-1 to disconnect it.",
    );
    await click("Stop using OpenCodex Home", confirmation());
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      modelRoute: "default",
      opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });
  it("explains account routing and no account switching before enabling Home", async () => {
    await render({
      settings: {
        setupMode: "existing",
        modelRoute: "default",
        opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
      },
    });
    await click("Use OpenCodex Home");
    expect(onChange).not.toHaveBeenCalled();
    expect(confirmation().textContent).toContain(
      "Codex on vps-1 will send model requests through OpenCodex Home and use its accounts. If Home is unavailable, this instance stops working instead of switching accounts.",
    );
    await click("Use OpenCodex Home", confirmation());
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      modelRoute: "opencodex",
      opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
    });
  });
  it("cancels the confirmation without mutating or refreshing", async () => {
    await render();
    await click("Stop using OpenCodex Home");
    await click("Cancel", confirmation());
    expect(onChange).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
  it("offers an existing instance from the managed card", async () => {
    const onAddInstance = vi.fn();
    await render({
      onAddInstance,
      settings: {
        setupMode: "managed",
        modelRoute: "default",
        opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
      },
    });
    await click("Add instance");
    expect(onAddInstance).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows provider_instance_busy and retains the confirmation for retry", async () => {
    onChange.mockRejectedValue({ code: "provider_instance_busy" });
    await render();
    await click("Stop using OpenCodex Home");
    await click("Stop using OpenCodex Home", confirmation());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Wait for this instance's active turns to finish before changing its model route.",
    );
    expect(confirmation()).not.toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
  });
  it("keeps a confirmation inert after permission is revoked", async () => {
    await render();
    await click("Stop using OpenCodex Home");
    await render({ readOnly: true });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("prevents repeated mutation while confirmation is pending", async () => {
    let finish!: () => void;
    onChange.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await click("Stop using OpenCodex Home");
    await click("Stop using OpenCodex Home", confirmation());
    await click("Stop using OpenCodex Home", confirmation());
    expect(onChange).toHaveBeenCalledOnce();
    await act(async () => finish());
  });
  it("saves a changed URL after confirmation without duplicating the route action", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "http://127.0.0.1:10101/v1",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Save URL")).toBeDefined();
    expect(button("Use OpenCodex Home", container)).toBeUndefined();
    expect(button("Stop using OpenCodex Home", container)).toBeDefined();
    await click("Save URL");
    expect(onChange).not.toHaveBeenCalled();
    await click("Use OpenCodex Home", confirmation());
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      modelRoute: "opencodex",
      opencodexBaseUrl: "http://127.0.0.1:10101/v1",
    });
  });
  it("checks status without mutating the route", async () => {
    await render();
    await click("Check status");
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
});
