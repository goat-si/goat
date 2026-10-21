import type { ComponentProps, ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { NoteOutboxRow } from "@goat/client-runtime/notes";
import { document as noteDocument, row } from "./test-fixtures";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    rows: [] as ReadonlyArray<NoteOutboxRow>,
    connected: false,
    taskIndex: 0,
    taskText: "task",
    read: vi.fn(),
    enqueue: vi.fn(),
    restore: vi.fn(),
    flush: vi.fn(),
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  Alert: { alert: vi.fn() },
  Platform: { OS: "ios" },
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => (
    <section data-testid="note-scroll-content">{children}</section>
  ),
}));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardAvoidingView: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: vi.fn(), dispatch: vi.fn(), navigate: vi.fn() }),
  usePreventRemove: () => undefined,
}));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: Children,
  AppTextInput: (props: {
    value: string;
    onChangeText: (value: string) => void;
    editable: boolean;
  }) => (
    <textarea
      value={props.value}
      disabled={!props.editable}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.read }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: ({
    markdown,
    onTaskListItemPress,
  }: {
    markdown: string;
    onTaskListItemPress?: (event: { index: number; checked: boolean; text: string }) => void;
  }) => {
    const [checked, setChecked] = useState(false);
    return (
      <>
        <p>{markdown}</p>
        <button
          disabled={!onTaskListItemPress}
          onClick={() => {
            setChecked(!checked);
            onTaskListItemPress?.({
              index: mocks.taskIndex,
              checked: !checked,
              text: mocks.taskText,
            });
          }}
        >
          Native checkbox {checked ? "checked" : "unchecked"}
        </button>
      </>
    );
  },
}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("../files/FileMarkdownPreview", () => ({ useMarkdownPreviewStyles: () => ({}) }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("./NoteLinkedThread", () => ({ NoteLinkedThread: () => null }));
vi.mock("./rpc/notes", () => ({ notesRpc: { read: {} } }));
vi.mock("./notes-state", () => ({
  notesCommandOptions: {},
  notesError: String,
  useNotesFeed: () => AsyncResult.success({ notes: [] }),
  useNotesOutbox: () => mocks.rows,
  useNoteDraftAccess: () => ({
    canEdit: true,
    canStart: mocks.connected,
    connected: mocks.connected,
  }),
  flushNotes: mocks.flush,
  notesOutbox: {
    restore: mocks.restore,
    getSnapshot: () => mocks.rows,
    enqueue: mocks.enqueue,
    error: () => undefined,
  },
}));

import { NoteRouteScreen } from "./NoteRouteScreen";

let root: Root;
let container: HTMLDivElement;
const props = {
  route: { params: { environmentId: "hub", path: "note.md" } },
} satisfies ComponentProps<typeof NoteRouteScreen>;
const render = () => root.render(<NoteRouteScreen {...props} />);
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function type(body: string) {
  const input = container.querySelector("textarea");
  if (!input) throw new Error("Missing note editor");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, body);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.rows = [row()];
  mocks.connected = false;
  mocks.taskIndex = 0;
  mocks.taskText = "task";
  mocks.read.mockReset().mockResolvedValue(AsyncResult.success(noteDocument()));
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.restore.mockReset().mockResolvedValue(undefined);
  mocks.flush.mockReset().mockResolvedValue(undefined);
});
afterEach(() => act(() => root.unmount()));

describe("note editor snapshot", () => {
  it("keeps unsaved text and releases saving after storage fails so the edit can be retried", async () => {
    const save = Promise.withResolvers<void>();
    mocks.enqueue.mockReturnValueOnce(save.promise);
    await act(async () => render());
    act(() => button("Edit markdown").click());
    act(() => type("keep this edit"));
    act(() => button("Save on phone").click());
    expect(button("Saving…").disabled).toBe(true);
    expect(container.querySelector("textarea")?.disabled).toBe(true);

    await act(async () => save.reject(new Error("Phone storage unavailable")));
    expect(container.textContent).toContain("Phone storage unavailable");
    expect(container.textContent).toContain("Unsaved edits");
    expect(container.querySelector("textarea")?.value).toBe("keep this edit");
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(button("Save on phone").disabled).toBe(false);
    expect(mocks.flush).not.toHaveBeenCalled();

    await act(async () => button("Save on phone").click());
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue.mock.calls[1]?.[0]).toMatchObject({ body: "keep this edit" });
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Phone storage unavailable");
  });

  it("updates the saved-on-phone status through send, conflict and acknowledgement", async () => {
    await act(async () => render());
    const scrollContent = container.querySelector('[data-testid="note-scroll-content"]');
    expect(scrollContent).not.toBeNull();
    expect(
      scrollContent?.textContent?.startsWith("Saved on this phone · syncs when connected"),
    ).toBe(true);
    await act(async () => {
      mocks.rows = [{ ...row(), inFlight: row() }];
      render();
    });
    expect(scrollContent?.textContent).toContain("Syncing…");
    expect(container.textContent).not.toContain("Saved on this phone · syncs when connected");
    await act(async () => {
      mocks.rows = [{ ...row(), state: "conflict", current: noteDocument("theirs") }];
      render();
    });
    expect(scrollContent?.textContent).toContain("Needs your choice");
    expect(button("Compare versions").disabled).toBe(false);
    await act(async () => {
      mocks.rows = [];
      mocks.connected = true;
      render();
    });
    expect(scrollContent?.textContent).toContain("Synced with hub");
    expect(container.textContent).not.toContain("Needs your choice");
  });

  it("keeps newer unsaved text visible and saveable after the pending version is acknowledged", async () => {
    await act(async () => render());
    act(() => button("Edit markdown").click());
    act(() => type("unsaved B"));
    expect(container.querySelector("textarea")?.value).toBe("unsaved B");
    expect(container.querySelector('[data-testid="note-scroll-content"]')?.textContent).toContain(
      "Unsaved edits",
    );
    await act(async () => {
      mocks.connected = true;
      mocks.rows = [];
      render();
    });
    expect(container.querySelector("textarea")?.value).toBe("unsaved B");
    expect(button("Save on phone").disabled).toBe(false);
    await act(async () => button("Save on phone").click());
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: "unsaved B" }));
  });

  it("keeps a clean pending snapshot available offline after acknowledgement", async () => {
    await act(async () => render());
    await act(async () => {
      mocks.rows = [];
      render();
    });
    expect(container.textContent).toContain("mine");
    act(() => button("Edit markdown").click());
    expect(container.querySelector("textarea")?.value).toBe("mine");
  });

  it("retains a draft restored after mount when acknowledgement is followed by a failed read", async () => {
    const restored = Promise.withResolvers<void>();
    mocks.rows = [];
    mocks.restore.mockReturnValue(restored.promise);
    await act(async () => render());
    await act(async () => {
      mocks.rows = [row()];
      restored.resolve();
      render();
    });
    mocks.read.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("connection lost"))));
    await act(async () => {
      mocks.rows = [];
      mocks.connected = true;
      render();
    });
    expect(mocks.read).toHaveBeenCalled();
    act(() => button("Edit markdown").click());
    expect(container.querySelector("textarea")?.value).toBe("mine");
  });

  it("adopts Use theirs when the editor has no active edits", async () => {
    mocks.rows = [{ ...row(), state: "conflict", current: noteDocument("theirs") }];
    await act(async () => render());
    await act(async () => {
      mocks.rows = [];
      render();
    });
    act(() => button("Edit markdown").click());
    expect(container.querySelector("textarea")?.value).toBe("theirs");
  });

  it("preserves dirty text when a conflict row is removed by Use theirs", async () => {
    await act(async () => render());
    act(() => button("Edit markdown").click());
    act(() => type("unsaved B"));
    await act(async () => {
      mocks.rows = [{ ...row(), state: "conflict", current: noteDocument("theirs") }];
      render();
    });
    await act(async () => {
      mocks.rows = [];
      render();
    });
    expect(container.querySelector("textarea")?.value).toBe("unsaved B");
    await act(async () => button("Save on phone").click());
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: "unsaved B" }));
  });
});

it.each([
  ["footnote suppression", "- a\n[^a]:\n    - [ ] foot\n\n- [ ] last", 0, "foot"],
  ["tabbed blockquote", ">\t- [ ] a\n>\t\n>\t    - [ ] b\n\n- [ ] c", 1, "c"],
  ["ordered task after code", "    a\n  2. [ ] b\n\n- [ ] c", 0, "b"],
] as const)(
  "keeps %s taps out of the outbox, resets native state and offers markdown editing",
  async (_name, body, index, text) => {
    mocks.rows = [{ ...row(), body }];
    mocks.taskIndex = index;
    mocks.taskText = text;
    await act(async () => render());
    await act(async () => button("Native checkbox unchecked").click());
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Use Edit markdown for this checkbox.");
    expect(button("Native checkbox unchecked")).toBeDefined();
    act(() => button("Edit markdown").click());
    expect(container.querySelector("textarea")?.value).toBe(body);
  },
);

it("enqueues a checkbox only when its native text and source slot agree", async () => {
  mocks.rows = [{ ...row(), body: "- [ ] **task**\n- [ ] other" }];
  await act(async () => render());
  await act(async () => button("Native checkbox unchecked").click());
  expect(mocks.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ body: "- [x] **task**\n- [ ] other" }),
  );
});
