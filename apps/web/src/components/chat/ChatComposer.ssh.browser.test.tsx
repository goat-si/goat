import { state, setupSshComposer, id, store, result, deferred } from "./sshComposerTestFixture";
import { act } from "../../../test/render";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
vi.mock("./MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("./ChatComposer", async (original) => {
  const actual = await original<typeof import("./ChatComposer")>();
  return {
    ...actual,
    ChatComposer: (props: ComponentProps<typeof actual.ChatComposer>) => {
      state.composer = props;
      return <actual.ChatComposer {...props} />;
    },
  };
});
it.each(["button", "keyboard"])(
  "allows an SSH %s send with a source-specific provider block",
  async (activation) => {
    await using fixture = await setupSshComposer(true);
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
  await using fixture = await setupSshComposer(true);
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
  await using fixture = await setupSshComposer(true);
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
  await using fixture = await setupSshComposer(true);
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
