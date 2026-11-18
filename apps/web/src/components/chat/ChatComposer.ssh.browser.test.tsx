import { state, setupSshComposer, id, store, result, deferred } from "~/test/sshComposerFixture";
import { ComposerContextId, EnvironmentId } from "@goat/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@goat/shared/composerContextClipboard";
import { formatComposerContextReference } from "@goat/shared/composerContextReferences";
import { act } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
import { ChatComposer } from "./ChatComposer";
import { editorIn } from "../ComposerPromptEditorTiptap.input.test-support";
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

it("attaches the native PNG when a snapshot is pasted inside a code fence", async () => {
  await using fixture = await setupComposer();
  const { mount, container } = fixture;
  store().setPrompt(id, "```text\ninside\n```");
  await mount();
  const editor = editorIn(container);
  await act(async () => {
    editor.commands.setTextSelection(2);
  });
  expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
  const dataUrl = document.createElement("canvas").toDataURL("image/png");
  const png = await (await fetch(dataUrl)).blob();
  const record = {
    version: 1 as const,
    kind: "image" as const,
    contextId: ComposerContextId.make("image_snapshot"),
    label: "shot.png",
    attachmentId: "snapshot",
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: png.size,
    source: {
      kind: "snap-shot" as const,
      capturedAt: "2026-01-01T00:00:00.000Z",
      appName: "Finder",
      windowTitle: "Downloads",
    },
  };
  const fragment = encodeComposerContextFragment({
    version: 1,
    source: { environmentId: EnvironmentId.make("local") },
    records: [record],
  });
  if (!fragment) throw new Error("Could not make snapshot clipboard fixture.");
  const transfer = new DataTransfer();
  transfer.items.add(new File([png], record.name, { type: png.type }));
  transfer.setData("text/plain", formatComposerContextReference(record));
  transfer.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);

  await act(async () => {
    editor.view.dom.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, cancelable: true, bubbles: true }),
    );
  });

  await vi.waitFor(() =>
    expect(
      store()
        .getComposerDraft(id)
        ?.images.map(({ name }) => name),
    ).toEqual([record.name]),
  );
  expect(store().getComposerDraft(id)?.images[0]?.source).toBeUndefined();
});
