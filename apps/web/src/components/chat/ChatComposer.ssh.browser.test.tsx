import { state, setupSshComposer, id, store, result, deferred } from "~/test/sshComposerFixture";
import { act } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
import { ChatComposer } from "./ChatComposer";
import { editorIn } from "../ComposerPromptEditorTiptap.input.test-support";
import { snapshotClipboardFixture } from "./snapshotClipboard.testkit";
const renderComposer = ChatComposer.type;
// Records the real composer's props; the fixture restores this spy after each test.
async function setupComposer() {
  const fixture = await setupSshComposer(true);
  vi.spyOn(ChatComposer, "type").mockImplementation((props) => {
    state.composer = props;
    return renderComposer(props);
  });
  return fixture;
}
it.each(["button", "keyboard"])(
  "allows an SSH %s send with a source-specific provider block",
  async (activation) => {
    await using fixture = await setupComposer();
    const { mount, container } = fixture;
    const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

    await mount();
    expect(submitButton().disabled).toBe(false);
    expect(state.composer!.composerRef.current!.getSendContext().providerAvailable).toBe(true);
    await act(async () => {
      if (activation === "button") submitButton().click();
      else
        container
          .querySelector('[contenteditable="true"]')!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
          );
    });
    expect(state.launch).toHaveBeenCalledTimes(1);
  },
);
it("retains the ordinary source-specific provider send block", async () => {
  await using fixture = await setupComposer();
  const { mount, container } = fixture;
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  store().setDraftThreadContext(id, { envMode: "local", sshDestination: null });
  await mount();
  expect(submitButton().disabled).toBe(true);
  expect(submitButton().getAttribute("aria-label")).toBe(
    "Install Antigravity in provider settings before sending.",
  );
  await act(async () => submitButton().click());
  expect(state.launch).not.toHaveBeenCalled();
});
it("keeps typing and paste editable during SSH launch", async () => {
  await using fixture = await setupComposer();
  const { mount, container } = fixture;
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  const launch = deferred<unknown>();
  state.launch.mockImplementation(() => launch.promise);
  await mount();
  await act(async () => submitButton().click());
  expect(state.composer!.isSendBusy).toBe(true);
  expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
  await act(async () => {
    expect(state.composer!.composerRef.current!.insertTextAtEnd(" typed")).toBe(true);
  });
  expect(store().getComposerDraft(id)?.prompt).toContain("typed");
  await act(async () => {
    state.composer!.composerRef.current!.focusAtEnd();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? " pasted" : ""),
      },
    });
    container.querySelector('[contenteditable="true"]')!.dispatchEvent(paste);
  });
  expect(store().getComposerDraft(id)?.prompt).toContain("typed");
  expect(store().getComposerDraft(id)?.prompt).toContain("pasted");
  await act(async () => {
    launch.resolve({ _tag: "Success", value: result });
  });
  expect(store().getDraftSession(id)).not.toBeNull();
  expect(store().getComposerDraft(id)?.prompt).toContain("pasted");
});
it.each(["attachment", "fanout", "absent model"])("keeps SSH %s blocked", async (blocker) => {
  await using fixture = await setupComposer();
  const { mount, container, primary } = fixture;
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  if (blocker === "absent model") primary.serverConfig!.providers = [];
  await mount();
  await act(async () => {
    if (blocker === "attachment")
      store().addImage(id, {
        id: "image",
        type: "image",
        name: "image",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl: "blob:image",
        file: new File(["x"], "image"),
      });
    if (blocker === "fanout") state.composer!.onMultipleModelSelectionsChange([]);
  });
  expect(submitButton().disabled).toBe(true);
  if (blocker !== "absent model")
    expect(submitButton().getAttribute("aria-label")).toBe(
      blocker === "attachment"
        ? "Remove attachments before sending to SSH."
        : "Choose one model before sending to SSH.",
    );
  await act(async () => submitButton().click());
  expect(state.launch).not.toHaveBeenCalled();
});

it.each([
  ["inside a code fence", true],
  ["alongside unrelated snapshot context", false],
] as const)("attaches the native PNG %s", async (_, fenced) => {
  await using fixture = await setupComposer();
  const { mount, container } = fixture;
  store().setPrompt(id, fenced ? "```text\ninside\n```" : "before");
  await mount();
  const editor = editorIn(container);
  await act(async () => {
    editor.commands.setTextSelection(2);
  });
  expect(editor.state.selection.$from.parent.type.name).toBe(fenced ? "codeBlock" : "paragraph");
  const { clipboard, record } = await snapshotClipboardFixture({ unrelatedPng: !fenced });

  await act(async () => {
    editor.view.dom.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: clipboard, cancelable: true, bubbles: true }),
    );
  });

  await vi.waitFor(() =>
    expect(
      store()
        .getComposerDraft(id)
        ?.images.map(({ name }) => name),
    ).toEqual([record.name]),
  );
  const attached = store().getComposerDraft(id)?.images[0];
  expect(attached?.source).toBeUndefined();
  expect(await attached?.file.arrayBuffer()).toEqual(await clipboard.files[0]?.arrayBuffer());
});

it("holds Send while the pasted PNG is being verified", async () => {
  await using fixture = await setupComposer();
  const { mount, container } = fixture;
  await mount();
  const editor = editorIn(container);
  const { clipboard, record } = await snapshotClipboardFixture({ unrelatedPng: true });
  const decodeStarted = deferred<void>();
  const resumeDecode = deferred<void>();
  const decode = window.createImageBitmap.bind(window);
  using _decode = vi.spyOn(window, "createImageBitmap").mockImplementationOnce(async (source) => {
    decodeStarted.resolve();
    await resumeDecode.promise;
    return decode(source);
  });
  const send = () => {
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!button) throw new Error("Send button is unavailable.");
    button.click();
  };

  try {
    await act(async () => {
      editor.view.dom.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: clipboard, cancelable: true, bubbles: true }),
      );
      await decodeStarted.promise;
    });
    await act(send);
    expect(state.launch).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Still bringing attached context into this message." }),
    );
  } finally {
    resumeDecode.resolve();
  }

  await vi.waitFor(() => {
    expect(store().getComposerDraft(id)?.images[0]?.name).toBe(record.name);
    expect(state.composer?.composerRef.current?.hasPendingAttachments()).toBe(false);
  });
  expect(state.launch).not.toHaveBeenCalled();
});
