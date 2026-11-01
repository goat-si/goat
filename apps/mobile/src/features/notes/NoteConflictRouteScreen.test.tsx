import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createNotesOutboxController } from "./outbox-controller";
import { document as noteDocument, row } from "./test-fixtures";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    controller: null as ReturnType<typeof createNotesOutboxController> | null,
    allowed: true,
    back: vi.fn(),
    flush: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 20 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: mocks.back }) }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./notes-state", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useNotesOutbox: () =>
      useSyncExternalStore(mocks.controller!.subscribe, mocks.controller!.getSnapshot),
    useNoteDraftAccess: () => ({ canEdit: mocks.allowed }),
    notesError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    notesOutbox: {
      resolve: (...args: Parameters<ReturnType<typeof createNotesOutboxController>["resolve"]>) =>
        mocks.controller!.resolve(...args),
    },
    flushNotes: mocks.flush,
  };
});

import { NoteConflictRouteScreen } from "./NoteConflictRouteScreen";
const props = {
  route: { params: { environmentId: "hub", path: "note.md" } },
} satisfies ComponentProps<typeof NoteConflictRouteScreen>;
let root: Root;
let container: HTMLDivElement;
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.allowed = true;
  mocks.back.mockReset();
  mocks.flush.mockReset().mockResolvedValue(undefined);
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.controller = createNotesOutboxController({
    load: async () => [
      { ...row(), body: "# Note\nphone", state: "conflict", current: noteDocument("# Note\nhub") },
    ],
    save: mocks.save,
    remove: mocks.remove,
  });
  await mocks.controller.restore();
});
afterEach(() => act(() => root.unmount()));

it("compares both versions and keeps the phone edit against the displayed hub revision", async () => {
  await act(async () => root.render(<NoteConflictRouteScreen {...props} />));
  expect(container.textContent).toContain("On this phone · idea");
  expect(container.textContent).toContain("On the hub · idea");
  expect(container.textContent).toContain("+ phone");
  expect(container.textContent).toContain("− hub");
  await act(async () => button("Keep mine").click());
  expect(mocks.controller!.getSnapshot()[0]).toMatchObject({
    body: "# Note\nphone",
    state: "pending",
    current: null,
    baseRevision: "b".repeat(64),
  });
  expect(mocks.flush).toHaveBeenCalledWith("hub");
  expect(mocks.back).toHaveBeenCalledOnce();
});

it("can accept the hub version while edit access is unavailable", async () => {
  mocks.allowed = false;
  await act(async () => root.render(<NoteConflictRouteScreen {...props} />));
  expect(button("Keep mine").disabled).toBe(true);
  expect(button("Use theirs").disabled).toBe(false);
  await act(async () => button("Use theirs").click());
  expect(mocks.controller!.getSnapshot()).toEqual([]);
  expect(mocks.back).toHaveBeenCalledOnce();
});

it("preserves both versions and allows retry after a local storage failure", async () => {
  mocks.remove.mockRejectedValueOnce(new Error("Phone storage unavailable"));
  await act(async () => root.render(<NoteConflictRouteScreen {...props} />));
  await act(async () => button("Use theirs").click());
  expect(container.textContent).toContain("Phone storage unavailable");
  expect(container.textContent).toContain("+ phone");
  expect(container.textContent).toContain("− hub");
  expect(mocks.back).not.toHaveBeenCalled();
  expect(mocks.controller!.getSnapshot()[0]?.state).toBe("conflict");
  await act(async () => button("Use theirs").click());
  expect(mocks.controller!.getSnapshot()).toEqual([]);
  expect(mocks.back).toHaveBeenCalledOnce();
});
