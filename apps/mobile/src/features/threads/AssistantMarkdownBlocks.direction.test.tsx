import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children, style }: { children?: ReactNode; style?: { direction?: "ltr" | "rtl" } }) => (
    <div style={style}>{children}</div>
  ),
  Pressable: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-haptics", () => ({}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../native/SelectableMarkdownText", () => ({ SelectableMarkdownText: () => null }));
vi.mock("./thread-work-log", () => ({ ThreadDisclosureChevron: () => null }));

import { AssistantMarkdownBlocks } from "./AssistantMarkdownBlocks";

it("renders an Arabic template in its reading direction and preserves its action", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onUse = vi.fn();
  try {
    await act(async () =>
      root.render(
        <AssistantMarkdownBlocks
          markdown={
            '::artifact-template{skill_name="artifact-template-report" skill_directory="/test/report" display_name="قالب تقرير" artifact_kind="document"}'
          }
          iconSubtleColor="#000"
          markdownStyles={{ nativeTextStyle: {} as never }}
          linkHandlers={{
            onLinkPress: () => {},
            fileContextMenu: () => undefined,
            onFileContextMenuAction: () => {},
          }}
          onUseArtifactTemplate={onUse}
          renderImage={() => null}
        />,
      ),
    );
    const label = [...container.querySelectorAll("span")].find(
      (element) => element.textContent === "قالب تقرير",
    );
    expect(label).toBeDefined();
    expect(label?.parentElement?.parentElement?.style.direction).toBe("rtl");
    await act(async () => container.querySelector("button")?.click());
    expect(onUse).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
