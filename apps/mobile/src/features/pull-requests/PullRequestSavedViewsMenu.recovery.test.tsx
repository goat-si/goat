import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ update: vi.fn(), confirm: vi.fn() }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../i18n/I18nProvider", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => children,
  useGT: () => (value: string) => value,
}));
vi.mock("../../components/ui/Dialog", () => ({ confirm: mocks.confirm, prompt: vi.fn() }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "new" }));
vi.mock("./usePullRequestListControls", () => ({
  usePullRequestSavedViews: () => ({
    views: [],
    status: "unreadable",
    ready: true,
    update: mocks.update,
  }),
}));
vi.mock("../workspace/ListFilterMenu", () => ({
  ListFilterMenu: ({
    actions,
    onSelect,
  }: {
    actions: Array<{ id: string; title: string; attributes?: { disabled?: boolean } }>;
    onSelect: (id: string) => void;
  }) => (
    <div>
      {actions.map((a) => (
        <button key={a.id} disabled={a.attributes?.disabled} onClick={() => onSelect(a.id)}>
          {a.title}
        </button>
      ))}
    </div>
  ),
}));
import { PullRequestSavedViewsMenu } from "./PullRequestSavedViewsMenu";

it("clears unreadable views only after confirmation", async () => {
  mocks.confirm.mockReset();
  mocks.update.mockReset().mockResolvedValue(undefined);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <PullRequestSavedViewsMenu
          scope={{
            environmentId: null,
            query: "",
            controls: { state: "open", involvement: "all", filters: {}, sort: "updated" },
          }}
          onApply={async () => {}}
        />,
      ),
    );
    expect(container.textContent).toContain("Saved views could not be read.");
    const clear = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear saved views",
    );
    await act(() => clear?.click());
    expect(mocks.update).not.toHaveBeenCalled();
    const confirmation = mocks.confirm.mock.calls[0]?.[0];
    expect(confirmation).toBeDefined();
    await act(async () => {
      confirmation.onConfirm();
    });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.update.mock.calls[0]?.[0]([{ id: "keep" }])).toEqual([]);
  } finally {
    await act(() => root.unmount());
  }
});
