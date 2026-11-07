import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  paste: vi.fn(),
  release: vi.fn(),
  onPaste: null as null | ((payload: unknown) => void),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("expo-paste-input", () => ({
  TextInputWrapper: (p: { children: ReactNode; onPaste: (payload: unknown) => void }) => {
    mocks.onPaste = p.onPaste;
    return <div>{p.children}</div>;
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  useWindowDimensions: () => ({ width: 400 }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  KeyboardStickyView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: () => <input />,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: () => null,
}));
vi.mock("../../components/ui/ControlPill", () => ({
  ControlPill: (p: { accessibilityLabel: string; onPress: () => void }) => (
    <button aria-label={p.accessibilityLabel} onClick={p.onPress} />
  ),
}));
vi.mock("../../lib/composerImages", () => ({
  pickComposerImages: mocks.pick,
  convertPastedImagesToAttachments: mocks.paste,
}));
vi.mock("../../state/use-composer-drafts", () => ({
  releaseUnusedComposerAttachmentFiles: mocks.release,
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  setPendingConnectionError: vi.fn(),
}));
vi.mock("../../state/use-thread-composer-state", () => ({ appendReviewCommentToDraft: vi.fn() }));
vi.mock("./reviewCommentSelection", () => ({
  clearReviewCommentTarget: vi.fn(),
  formatReviewCommentContext: vi.fn(),
  getReviewUnifiedLineNumber: vi.fn(),
  getSelectedReviewCommentLines: () => [],
  useReviewCommentTarget: () => ({ filePath: "file.ts" }),
}));
vi.mock("../settings/appearance/useAppearanceCodeSurface", () => ({
  useAppearanceCodeSurface: () => ({ codeSurface: { rowHeight: 20, fontSize: 12 } }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("./reviewDiffRendering", () => ({
  changeTone: vi.fn(),
  DiffTokenText: () => null,
  ReviewChangeBar: () => null,
}));
vi.mock("./highlightReviewSelectedLines", () => ({ highlightReviewSelectedLines: () => ({}) }));

import { ReviewCommentComposerSheet } from "./ReviewCommentComposerSheet";
import { isComposerAttachmentFileRetained } from "../../lib/composerAttachmentFiles";
import { EnvironmentId, ThreadId } from "@goat/contracts";

it.each(["picker", "paste"] as const)(
  "releases a review comment %s result after unmount",
  async (method) => {
    mocks.release.mockReset().mockResolvedValue(undefined);
    const pending = Promise.withResolvers<
      ReadonlyArray<{
        id: string;
        type: "image";
        name: string;
        mimeType: string;
        sizeBytes: number;
        fileUri: string;
      }>
    >();
    mocks.pick.mockImplementation(() =>
      pending.promise.then((images) => ({ images, error: null })),
    );
    mocks.paste.mockImplementation(() => pending.promise);
    const image = {
      id: method,
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 4,
      fileUri: `file:///documents/${method}.png`,
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <ReviewCommentComposerSheet
          route={{
            params: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
          }}
        />,
      ),
    );
    await act(async () => {
      if (method === "picker")
        container.querySelector<HTMLButtonElement>('[aria-label="Add image"]')?.click();
      else mocks.onPaste?.({ type: "images", uris: ["file:///original.png"] });
    });
    await act(async () => root.unmount());
    container.remove();
    await act(async () => {
      pending.resolve([image]);
      await pending.promise;
    });
    expect(isComposerAttachmentFileRetained(image.fileUri)).toBe(false);
    expect(mocks.release).toHaveBeenCalledWith([image]);
  },
);
