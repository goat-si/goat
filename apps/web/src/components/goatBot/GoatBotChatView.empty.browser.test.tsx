import { EnvironmentId, ThreadId } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModeButton", () => ({ GoatBotModeButton: () => null }));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({ GoatBotAvatar: () => null }));

import { GoatBotChatView } from "./GoatBotChatView";

let root: Root;
let container: HTMLDivElement;
const onSend = vi.fn<(text: string) => void>();
const example = "Review the latest changes";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSend.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(canOperate: boolean) {
  await act(() =>
    root.render(
      <GoatBotChatView
        availability={{
          kind: "ready",
          bot: { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("bot") },
        }}
        canOperate={canOperate}
        rows={[]}
        onSend={onSend}
        onRetryInput={() => {}}
        legacyAgentRoute={null}
      />,
    ),
  );
}

it("seeds the composer without sending and refills it when the same example is picked again", async () => {
  await render(true);
  expect(container.querySelector("h1")?.textContent).toContain("GOAT Bot");
  expect(container.querySelector("header p")).toBeNull();
  const exampleButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === example,
  );
  expect(exampleButton).toBeDefined();
  await act(() => exampleButton!.click());
  let textarea = container.querySelector("textarea")!;
  expect(textarea.value).toBe(example);
  expect(onSend).not.toHaveBeenCalled();

  await act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, "");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(textarea.value).toBe("");
  await act(() => exampleButton!.click());
  textarea = container.querySelector("textarea")!;
  expect(textarea.value).toBe(example);
  expect(onSend).not.toHaveBeenCalled();
});

it("does not offer example buttons without send permission", async () => {
  await render(false);
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === example),
  ).toBe(false);
});
