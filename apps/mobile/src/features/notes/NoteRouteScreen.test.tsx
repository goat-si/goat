import type { ComponentProps, ReactNode } from "react";
import {
  act,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { NoteConflictError } from "@goat/contracts";
import type { NoteOutboxRow } from "@goat/client-runtime/notes";
import { document as noteDocument, row } from "./test-fixtures";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    revision: 0,
    listeners: new Set<() => void>(),
    rows: [] as ReadonlyArray<NoteOutboxRow>,
    connected: false,
    taskIndex: 0,
    taskText: "task",
    read: vi.fn(),
    remove: vi.fn(),
    alert: vi.fn(),
    goBack: vi.fn(),
    enqueue: vi.fn(),
    restore: vi.fn(),
    flush: vi.fn(),
    serialize: (markdown: string): string | Promise<string> => markdown,
    dispatch: vi.fn(),
    composing: "",
    blurHangs: false,
    preventRemove: null as null | {
      enabled: boolean;
      callback: (event: { data: { action: unknown } }) => void;
    },
    inputProps: null as null | {
      onChangeSelection: (selection: { start: number; end: number }) => void;
      onChangeState: (state: unknown) => void;
    },
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: { children?: ReactNode; disabled?: boolean; onPress?: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  Alert: { alert: mocks.alert },
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
  useNavigation: () => ({ goBack: mocks.goBack, dispatch: mocks.dispatch, navigate: vi.fn() }),
  usePreventRemove: (
    enabled: boolean,
    callback: (event: { data: { action: unknown } }) => void,
  ) => {
    mocks.preventRemove = { enabled, callback };
  },
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
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "delete" ? mocks.remove : mocks.read,
}));
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
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("react-native-enriched-markdown", () => ({
  // Uncontrolled like the native input; getMarkdown runs the stand-in serializer.
  EnrichedMarkdownTextInput: (props: {
    ref: { current: unknown };
    defaultValue: string;
    editable: boolean;
    onChangeText: (text: string) => void;
    onFocus: () => void;
    onBlur: () => void;
    onChangeSelection: (selection: { start: number; end: number }) => void;
    onChangeState: (state: unknown) => void;
  }) => {
    mocks.inputProps = props;
    const element = useRef<HTMLTextAreaElement>(null);
    const [initial] = useState(props.defaultValue);
    // The native input reads defaultValue once; a DOM defaultValue would reset typed text.
    useLayoutEffect(() => {
      if (element.current) element.current.value = initial;
    }, [initial]);
    useImperativeHandle(props.ref, () => ({
      getMarkdown: async () => mocks.serialize(element.current?.value ?? ""),
      focus: () => props.onFocus(),
      setSelection: () => undefined,
      // Like UIKit, ending input commits a composition still marked in the field.
      blur: () => {
        if (mocks.composing && element.current) {
          element.current.value += mocks.composing;
          mocks.composing = "";
          props.onChangeText(element.current.value);
        }
        if (!mocks.blurHangs) props.onBlur();
      },
      setValue: (markdown: string) => {
        if (element.current) element.current.value = markdown;
      },
    }));
    return (
      <textarea
        ref={element}
        aria-label="Visual note"
        disabled={!props.editable}
        onChange={(event) => props.onChangeText(event.target.value)}
      />
    );
  },
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("./NoteLinkedThread", () => ({ NoteLinkedThread: () => null }));
vi.mock("./rpc/notes", () => ({
  notesRpc: { read: { label: "read" }, delete: { label: "delete" } },
}));
vi.mock("./notes-state", () => ({
  notesCommandOptions: {},
  notesError: String,
  useNotesFeed: () => AsyncResult.success({ notes: [] }),
  useNotesOutbox: () => {
    useSyncExternalStore(
      (listener) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
      },
      () => mocks.revision,
    );
    return mocks.rows;
  },
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
// Load the lazy editor once up front so each test waits only for its own render.
await import("./NoteVisualEditor");

let root: Root;
let container: HTMLDivElement;
const props = {
  route: { params: { environmentId: "hub", path: "note.md" } },
} satisfies ComponentProps<typeof NoteRouteScreen>;
const render = () => {
  mocks.revision++;
  for (const listener of mocks.listeners) listener();
  root.render(<NoteRouteScreen {...props} />);
};
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
/** Opens the editor and waits for the lazy visual editor to load and check the note. */
async function edit() {
  await act(async () => button("Edit").click());
  await act(() =>
    vi.waitFor(() => {
      const text = container.textContent ?? "";
      if (text.includes("Opening editor") || text.includes("Checking this note"))
        throw new Error("Editor still opening");
    }),
  );
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
  mocks.remove.mockReset().mockResolvedValue(AsyncResult.success({ path: "note.md" }));
  mocks.alert.mockReset();
  mocks.goBack.mockReset();
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.restore.mockReset().mockResolvedValue(undefined);
  mocks.flush.mockReset().mockResolvedValue(undefined);
  mocks.serialize = (markdown: string): string | Promise<string> => markdown;
  mocks.dispatch.mockReset();
  mocks.composing = "";
  mocks.blurHangs = false;
  mocks.preventRemove = null;
});
afterEach(() => act(() => root.unmount()));

/** Presses the destructive choice of the last confirmation the screen showed. */
function confirmLastAlert() {
  const choices = mocks.alert.mock.calls.at(-1)?.[2] as
    | ReadonlyArray<{ style?: string; onPress?: () => void }>
    | undefined;
  const confirm = choices?.find((choice) => choice.style === "destructive");
  if (!confirm?.onPress) throw new Error("Missing destructive confirmation");
  return confirm.onPress;
}

describe("note delete", () => {
  const synced = async () => {
    mocks.rows = [];
    mocks.connected = true;
    await act(async () => render());
  };

  it("deletes the loaded revision only after confirmation, then leaves the note", async () => {
    await synced();
    act(() => button("Delete note").click());
    expect(mocks.remove).not.toHaveBeenCalled();
    await act(async () => confirmLastAlert()());
    expect(mocks.remove).toHaveBeenCalledWith({
      environmentId: "hub",
      input: { path: "note.md", baseRevision: "b".repeat(64) },
    });
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });

  it("keeps the note on a conflict, shows the hub's version and asks again before retrying", async () => {
    await synced();
    const current = noteDocument("theirs", "c".repeat(64));
    mocks.remove.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(new NoteConflictError({ path: current.path, current, message: "changed" })),
      ),
    );
    act(() => button("Delete note").click());
    await act(async () => confirmLastAlert()());
    expect(mocks.goBack).not.toHaveBeenCalled();
    expect(container.textContent).toContain("theirs");
    expect(container.textContent).toContain("This note changed on the hub");
    expect(mocks.alert).toHaveBeenCalledOnce();
    act(() => button("Delete note").click());
    expect(mocks.alert).toHaveBeenCalledTimes(2);
    await act(async () => confirmLastAlert()());
    expect(mocks.remove).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: { path: "note.md", baseRevision: "c".repeat(64) },
    });
  });

  it("keeps the conflict version when an older read finishes after it", async () => {
    await synced();
    const older = Promise.withResolvers<unknown>();
    mocks.read.mockReturnValueOnce(older.promise);
    await act(async () => button("Refresh / sync").click());
    const current = noteDocument("theirs", "c".repeat(64));
    mocks.remove.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(new NoteConflictError({ path: current.path, current, message: "changed" })),
      ),
    );
    act(() => button("Delete note").click());
    await act(async () => confirmLastAlert()());
    await act(async () => older.resolve(AsyncResult.success(noteDocument("older"))));
    expect(container.textContent).toContain("theirs");
    expect(container.textContent).not.toContain("older");
    expect(container.textContent).toContain("This note changed on the hub");
  });

  it("is unavailable offline or while this phone holds a draft", async () => {
    await synced();
    expect(button("Delete note").disabled).toBe(false);
    await act(async () => {
      mocks.connected = false;
      render();
    });
    expect(button("Delete note").disabled).toBe(true);
    await act(async () => {
      mocks.rows = [row()];
      mocks.connected = true;
      render();
    });
    expect(button("Delete note").disabled).toBe(true);
  });

  it("refuses a confirmation that arrives after a draft was saved on this phone", async () => {
    await synced();
    act(() => button("Delete note").click());
    mocks.rows = [row()];
    await act(async () => confirmLastAlert()());
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Sync or discard them before deleting");
  });

  it("sends one request while a delete is in flight and blocks edits meanwhile", async () => {
    await synced();
    const pending = Promise.withResolvers<unknown>();
    mocks.remove.mockReturnValueOnce(pending.promise);
    act(() => button("Delete note").click());
    const confirm = confirmLastAlert();
    await act(async () => {
      confirm();
      confirm();
    });
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(button("Deleting…").disabled).toBe(true);
    expect(button("Edit").disabled).toBe(true);
    await act(async () =>
      pending.resolve(AsyncResult.failure(Cause.fail(new Error("connection lost")))),
    );
    expect(mocks.goBack).not.toHaveBeenCalled();
    expect(container.textContent).toContain("connection lost");
    expect(button("Delete note").disabled).toBe(false);
  });
});

describe("note editor snapshot", () => {
  it("keeps unsaved text and releases saving after storage fails so the edit can be retried", async () => {
    const save = Promise.withResolvers<void>();
    mocks.enqueue.mockReturnValueOnce(save.promise);
    await act(async () => render());
    await edit();
    act(() => type("keep this edit"));
    await act(async () => button("Save on phone").click());
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
    await edit();
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
    await edit();
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
    await edit();
    expect(container.querySelector("textarea")?.value).toBe("mine");
  });

  it("adopts Use theirs when the editor has no active edits", async () => {
    mocks.rows = [{ ...row(), state: "conflict", current: noteDocument("theirs") }];
    await act(async () => render());
    await act(async () => {
      mocks.rows = [];
      render();
    });
    await edit();
    expect(container.querySelector("textarea")?.value).toBe("theirs");
  });

  it("preserves dirty text when a conflict row is removed by Use theirs", async () => {
    await act(async () => render());
    await edit();
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
    expect(container.textContent).toContain("Edit the note to change this checkbox.");
    expect(button("Native checkbox unchecked")).toBeDefined();
    await edit();
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

describe("visual note editor", () => {
  it("saves a CRLF note's original bytes when it is opened and saved without edits", async () => {
    const body = "# Title\r\n\r\nSome **bold** text\r\n";
    mocks.rows = [{ ...row(), body }];
    await act(async () => render());
    await edit();
    expect(container.querySelector('[aria-label="Visual note"]')).not.toBeNull();
    await act(async () => button("Save on phone").click());
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body }));
  });

  it("opens a note with a code block as markdown and says why", async () => {
    const body = "Intro\n\n```ts\nconst x = 1;\n```\n";
    mocks.rows = [{ ...row(), body }];
    await act(async () => render());
    await edit();
    expect(container.textContent).toContain(
      "Opened as markdown because this note has a code block.",
    );
    expect(container.querySelector('[aria-label="Visual note"]')).toBeNull();
    expect(container.querySelector("textarea")?.value).toBe(body);
  });

  it("falls back to markdown when the native serializer would rewrite untouched text", async () => {
    mocks.serialize = (markdown) => markdown.replace("* item", "- item");
    mocks.rows = [{ ...row(), body: "* item\n" }];
    await act(async () => render());
    await edit();
    expect(container.textContent).toContain("the visual editor would rewrite parts of this note");
    expect(container.querySelector("textarea")?.value).toBe("* item\n");
  });

  it("a second Save tap while the editor is being read saves once, with the edit", async () => {
    await act(async () => render());
    await edit();
    act(() => type("edited"));
    const read = Promise.withResolvers<string>();
    mocks.serialize = () => read.promise;
    await act(async () => button("Save on phone").click());
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Visual note"]')?.disabled,
    ).toBe(true);
    expect(button("B").disabled).toBe(true);
    await act(async () => button("Save on phone").click());
    await act(async () => read.resolve("edited"));
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: "edited" }));
  });

  it("a failed editor read keeps the edit open and says why", async () => {
    await act(async () => render());
    await edit();
    act(() => type("edited"));
    mocks.serialize = () => Promise.reject(new Error("native read failed"));
    await act(async () => button("Save on phone").click());
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(container.textContent).toContain("native read failed");
    expect(container.textContent).toContain("Unsaved edits");
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Visual note"]')?.disabled,
    ).toBe(false);
  });

  it("a new note's editor opens with the draft restored after the screen mounted", async () => {
    const restoredDraft = Promise.withResolvers<void>();
    mocks.rows = [];
    mocks.restore.mockReturnValue(restoredDraft.promise);
    await act(async () =>
      root.render(
        <NoteRouteScreen
          route={{ params: { environmentId: "hub", path: "note.md", create: true } }}
        />,
      ),
    );
    expect(container.querySelector('[aria-label="Visual note"]')).toBeNull();
    await act(async () => {
      mocks.rows = [row()];
      restoredDraft.resolve();
    });
    await act(() =>
      vi.waitFor(() =>
        expect(
          container.querySelector<HTMLTextAreaElement>('[aria-label="Visual note"]')?.value,
        ).toBe("mine"),
      ),
    );
  });

  it("leaving the visual editor asks first when only native formatting changed the note", async () => {
    await act(async () => render());
    await edit();
    expect(container.textContent).not.toContain("Unsaved edits");
    mocks.serialize = () => "**mine**";
    expect(mocks.preventRemove?.enabled).toBe(true);
    await act(async () => mocks.preventRemove?.callback({ data: { action: "back" } }));
    expect(mocks.alert).toHaveBeenCalledWith("Unsaved note", expect.any(String), expect.any(Array));
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("leaving an unchanged visual editor goes straight back", async () => {
    await act(async () => render());
    await edit();
    expect(mocks.preventRemove?.enabled).toBe(true);
    await act(async () => mocks.preventRemove?.callback({ data: { action: "back" } }));
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledWith("back");
  });

  it("typing that arrives while undo reads the note is kept", async () => {
    await act(async () => render());
    await edit();
    act(() => type("first"));
    const read = Promise.withResolvers<string>();
    mocks.serialize = () => read.promise;
    await act(async () => button("↶").click());
    act(() => type("first and more"));
    await act(async () => read.resolve("first"));
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Visual note"]')?.value).toBe(
      "first and more",
    );
  });

  it("saving before the open check finishes keeps the original bytes", async () => {
    const opening = Promise.withResolvers<string>();
    mocks.serialize = () => opening.promise;
    await act(async () => render());
    await act(async () => button("Edit").click());
    await act(() =>
      vi.waitFor(() => expect(container.textContent).toContain("Checking this note")),
    );
    mocks.serialize = () => "- rewritten";
    await act(async () => button("Save on phone").click());
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: "mine" }));
  });

  it("switching to markdown after a formatting-only change keeps it as an unsaved edit", async () => {
    await act(async () => render());
    await edit();
    mocks.serialize = () => "**mine**";
    await act(async () => button("Edit as markdown").click());
    expect(container.querySelector("textarea")?.value).toBe("**mine**");
    expect(container.textContent).toContain("Unsaved edits");
    expect(mocks.preventRemove?.enabled).toBe(true);
  });

  it("typing during the leave check keeps the screen and asks", async () => {
    await act(async () => render());
    await edit();
    const read = Promise.withResolvers<string>();
    mocks.serialize = () => read.promise;
    await act(async () => mocks.preventRemove?.callback({ data: { action: "back" } }));
    act(() => type("typed while leaving"));
    mocks.serialize = (markdown) => markdown;
    await act(async () => read.resolve("mine"));
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith("Unsaved note", expect.any(String), expect.any(Array));
  });

  it("a native read that never answers ends in a prompt instead of a stuck screen", async () => {
    await act(async () => render());
    await edit();
    mocks.serialize = () => new Promise<string>(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => mocks.preventRemove?.callback({ data: { action: "back" } }));
      await act(async () => vi.advanceTimersByTime(5000));
    } finally {
      vi.useRealTimers();
    }
    expect(container.textContent).toContain("The editor did not answer. Try again.");
    expect(mocks.alert).toHaveBeenCalledWith("Unsaved note", expect.any(String), expect.any(Array));
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("Back during a save read keeps the screen and offers no discard", async () => {
    await act(async () => render());
    await edit();
    act(() => type("edited"));
    const read = Promise.withResolvers<string>();
    mocks.serialize = () => read.promise;
    await act(async () => button("Save on phone").click());
    await act(async () => mocks.preventRemove?.callback({ data: { action: "back" } }));
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    await act(async () => read.resolve("edited"));
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: "edited" }));
  });

  it("a failed background undo snapshot is shown and the edit stays", async () => {
    await act(async () => render());
    await edit();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => type("typed"));
      mocks.serialize = () => Promise.reject(new Error("native read failed"));
      await act(async () => vi.advanceTimersByTime(600));
    } finally {
      vi.useRealTimers();
    }
    expect(container.textContent).toContain("native read failed");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Visual note"]')?.value).toBe(
      "typed",
    );
  });

  it("a failed undo is shown and unlocks the editor", async () => {
    await act(async () => render());
    await edit();
    act(() => type("typed"));
    mocks.serialize = () => Promise.reject(new Error("native read failed"));
    await act(async () => button("↶").click());
    expect(container.textContent).toContain("native read failed");
    expect(
      container.querySelector<HTMLTextAreaElement>('[aria-label="Visual note"]')?.disabled,
    ).toBe(false);
  });

  it("Save commits a character still being composed before reading the note", async () => {
    await act(async () => render());
    await edit();
    mocks.composing = "한";
    await act(async () => button("Save on phone").click());
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: "mine한" }));
  });

  it("a blur that never confirms fails the save instead of reading without a boundary", async () => {
    await act(async () => render());
    await edit();
    act(() => type("edited"));
    mocks.blurHangs = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => button("Save on phone").click());
      await act(async () => vi.advanceTimersByTime(1000));
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The editor did not finish input. Try again.");
    expect(button("Save on phone").disabled).toBe(false);
  });

  it("undo reverts an edit that sent no text event, such as a list key", async () => {
    await act(async () => render());
    await edit();
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Visual note"]');
    if (field) field.value = "- mine";
    await act(async () => button("↶").click());
    await act(async () => button("↶").click());
    expect(field?.value).toBe("mine");
  });

  it("undo right after typing restores the opened text", async () => {
    await act(async () => render());
    await edit();
    act(() => type("typed"));
    expect(button("↶").disabled).toBe(false);
    await act(async () => button("↶").click());
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Visual note"]')?.value).toBe(
      "mine",
    );
  });

  it("carries visual edits into the markdown editor and back", async () => {
    await act(async () => render());
    await edit();
    act(() => type("**changed**"));
    await act(async () => button("Edit as markdown").click());
    expect(container.querySelector('[aria-label="Visual note"]')).toBeNull();
    expect(container.querySelector("textarea")?.value).toBe("**changed**");
    await act(async () => button("Edit visually").click());
    await act(() =>
      vi.waitFor(() =>
        expect(container.querySelector('[aria-label="Visual note"]')).not.toBeNull(),
      ),
    );
    expect(container.querySelector("textarea")?.value).toBe("**changed**");
    await act(async () => button("Save on phone").click());
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: "**changed**" }));
  });
});
