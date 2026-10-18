import { EnvironmentId, ProviderInstanceId, DEFAULT_OPENCODEX_BASE_URL } from "@goat/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useRef: reactHookHarness.useRef };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { CodexHomeRouteSection, type CodexHomeRouteSectionProps } from "./CodexHomeRouteSection";

function render(overrides: Partial<CodexHomeRouteSectionProps> = {}) {
  hooks.beginRender();
  return CodexHomeRouteSection({
    environmentId: EnvironmentId.make("vps"),
    environmentLabel: "vps-1",
    instanceId: ProviderInstanceId.make("codex_home"),
    readOnly: false,
    settings: {
      setupMode: "existing",
      modelRoute: "opencodex",
      opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
    },
    onChange: vi.fn().mockResolvedValue(undefined),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onAddInstance: vi.fn(),
    ...overrides,
  });
}
function click(tree: unknown, label: string) {
  // Controls live in SettingsRow.control, so inspect that subtree as well.
  const find = (node: unknown): ReturnType<typeof visitElements> => {
    const direct = visitElements(
      node,
      (entry) => entry.props.children === label && typeof entry.props.onClick === "function",
    );
    if (direct) return direct;
    let match: ReturnType<typeof visitElements> = null;
    visitElements(node, (entry) => {
      if (entry.props.control) match ??= find(entry.props.control);
      return false;
    });
    return match;
  };
  const button = find(tree);
  if (!button) throw new Error(`Missing action ${label}`);
  return (button.props.onClick as () => void)();
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("OpenCodex Home routing", () => {
  beforeEach(() => hooks.reset());
  it("hands Connect to the person without changing settings", () => {
    const onChange = vi.fn();
    click(render({ onChange }), "Connect to Home");
    const tree = render({ onChange });
    expect(
      visitElements(
        tree,
        (entry) =>
          typeof entry.props.description === "string" &&
          entry.props.description.includes("On vps-1, open a terminal"),
      ),
    ).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("saves default after Stop using OpenCodex Home confirmation", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined),
      onRefresh = vi.fn().mockResolvedValue(undefined);
    const props = { onChange, onRefresh };
    click(render(props), "Stop using OpenCodex Home");
    expect(onChange).not.toHaveBeenCalled();
    const confirm = visitElements(render(props), (entry) => entry.props.role === "alertdialog");
    expect(confirm).not.toBeNull();
    click(confirm, "Stop using OpenCodex Home");
    await settle();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      modelRoute: "default",
      opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });
  it("requires confirmation before enabling the Home route", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const props = {
      onChange,
      settings: {
        setupMode: "existing" as const,
        modelRoute: "default" as const,
        opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
      },
    };
    click(render(props), "Use OpenCodex Home");
    expect(onChange).not.toHaveBeenCalled();
    click(
      visitElements(render(props), (entry) => entry.props.role === "alertdialog"),
      "Use OpenCodex Home",
    );
    await settle();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      modelRoute: "opencodex",
      opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
    });
  });
  it("offers an existing instance from the managed card", () => {
    const onAddInstance = vi.fn(),
      onChange = vi.fn();
    click(
      render({
        onAddInstance,
        onChange,
        settings: {
          setupMode: "managed",
          modelRoute: "default",
          opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
        },
      }),
      "Add instance",
    );
    expect(onAddInstance).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows provider_instance_busy from the server", async () => {
    const onChange = vi.fn().mockRejectedValue({ code: "provider_instance_busy" });
    click(render({ onChange }), "Stop using OpenCodex Home");
    click(
      visitElements(render({ onChange }), (entry) => entry.props.role === "alertdialog"),
      "Stop using OpenCodex Home",
    );
    await settle();
    const tree = render({ onChange });
    expect(visitElements(tree, (entry) => entry.props.role === "alert")?.props.children).toBe(
      "End this instance's active sessions before changing its model route.",
    );
    expect(visitElements(tree, (entry) => entry.props.role === "alertdialog")).not.toBeNull();
  });
  it("keeps a confirmation inert after permission is revoked", () => {
    const onChange = vi.fn();
    click(render({ onChange }), "Stop using OpenCodex Home");
    const tree = render({ onChange, readOnly: true });
    expect(visitElements(tree, (entry) => entry.props.role === "alertdialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("prevents repeated mutation while the first confirmation is pending", () => {
    const onChange = vi.fn().mockReturnValue(new Promise(() => {}));
    click(render({ onChange }), "Stop using OpenCodex Home");
    const confirmation = visitElements(
      render({ onChange }),
      (entry) => entry.props.role === "alertdialog",
    );
    click(confirmation, "Stop using OpenCodex Home");
    click(confirmation, "Stop using OpenCodex Home");
    expect(onChange).toHaveBeenCalledOnce();
  });
});
