import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const View = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  const Text = ({ children }: { children?: ReactNode }) => createElement("span", null, children);
  return {
    View,
    Text,
    Pressable: View,
    ScrollView: View,
    ActivityIndicator: () => null,
    Image: { resolveAssetSource: () => null },
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    Share: { share: vi.fn() },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    TurboModuleRegistry: {
      get: () => null,
      getEnforcing: () => ({
        getNativeLocales: () => [],
        nativeStoreGet: () => null,
        nativeStoreSet: () => {},
      }),
    },
  };
});
// The native renderer shows the reply and the Copy item of its text selection menu.
vi.mock("react-native-enriched-markdown", async () => {
  const { createElement } = await import("react");
  return {
    EnrichedMarkdownText: (props: {
      markdown: string;
      selectionMenuConfig: { copy: { label: string } };
    }) =>
      createElement(
        "p",
        { "data-selection-copy": props.selectionMenuConfig.copy.label },
        props.markdown,
      ),
  };
});
vi.mock("./features/cloud/CloudAuthProvider", () => ({
  CloudAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./features/settings/appearance/AppearancePreferencesProvider", () => ({
  AppearancePreferencesProvider: ({ children }: { children: ReactNode }) => children,
  useAppearancePreferences: () => ({
    themeAppearance: "light",
    mathRenderingEnabled: false,
    themeVariables: new Proxy({}, { get: () => "#336699" }),
  }),
}));
vi.mock("./native/useEnrichedLinkVariants", () => ({
  useEnrichedLinkVariants: () => ({ linkVariants: {}, linkPillContent: undefined }),
}));
// Saved preferences live in native storage; the language stays the default while they load.
vi.mock("./state/preferences", () => ({
  mobilePreferencesAtom: Atom.make(AsyncResult.initial()),
}));
vi.mock("./native/HighlightedCodeBlock", async () => ({
  HighlightedCodeBlock: () => null,
  OpenFenceCodeContext: (await import("react")).createContext(null),
}));
vi.mock("./native/MermaidCodeBlock", () => ({ MermaidCodeBlock: () => null }));
vi.mock("./components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("./lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));

import { AppProviders } from "./AppProviders";
import { SelectableMarkdownText } from "./native/SelectableMarkdownText";

// Every assistant reply calls useGT, which throws outside the root GTProvider.
it("an assistant reply renders inside the app's providers with its translated selection menu (#3996)", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const reply = "Here is the capture: ![after](https://example.test/after.png)";
  try {
    await act(async () =>
      root.render(
        <AppProviders>
          <SelectableMarkdownText markdown={reply} textStyle={{} as never} />
        </AppProviders>,
      ),
    );
    const message = container.querySelector("p");
    expect(message?.textContent).toBe(reply);
    expect(message?.dataset.selectionCopy).toBe("Copy");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
