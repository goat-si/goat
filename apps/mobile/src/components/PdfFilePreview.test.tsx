import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";

const mock = vi.hoisted(() => ({ share: vi.fn(), source: vi.fn() }));
vi.mock("react-native", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-image-viewing", () => ({ default: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../lib/attachmentDownload", () => ({ openAttachmentInViewer: vi.fn() }));
vi.mock("../state/mediaActions", () => ({
  useMediaActions: (source: unknown) => {
    mock.source(source);
    return { sharing: false, actions: source ? [{ id: "save", run: mock.share }] : [] };
  },
}));
vi.mock("./ui/Button", () => ({ Button: () => null }));
vi.mock("./ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("./MediaImagePreview", () => ({ MediaImagePreview: () => null }));
vi.mock("./PdfPreview", () => ({ PdfPreview: () => <div>PDF</div> }));
vi.mock("./ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./ui/ControlPill", () => ({
  ControlPill: (props: {
    accessibilityLabel?: string;
    label?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button
      aria-label={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));
import { FilePreview } from "./FilePreview";

it("shares a PDF using its original media source", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const actionsSource = {
    name: "report.pdf",
    mimeType: "application/pdf",
    uri: "file:///report.pdf",
  };
  try {
    await act(async () =>
      root.render(
        <FilePreview
          source={{ kind: "pdf", uri: "file:///report.pdf", actionsSource }}
          onRequestClose={() => {}}
        />,
      ),
    );
    expect(mock.source).toHaveBeenCalledWith(actionsSource);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Save or share"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(mock.share).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
