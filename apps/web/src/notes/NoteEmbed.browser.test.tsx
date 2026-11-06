import type { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import type { NoteUpload } from "./noteUploads";

const state = vi.hoisted(() => ({
  minted: "",
  remints: [] as string[],
  remintCalls: 0,
  uploads: [] as Array<{
    file: File;
    signal: AbortSignal;
    resolve: (result: NoteUpload) => void;
  }>,
}));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: state.minted, expiresAt: 0 }),
  useAssetUrlRefresh: () => async () => {
    state.remintCalls++;
    return state.remints.shift() ?? null;
  },
}));
vi.mock("./noteUploads", () => ({
  uploadNoteFile: (input: { file: File; signal: AbortSignal }) =>
    new Promise<NoteUpload>((resolve) => state.uploads.push({ ...input, resolve })),
}));

import { NoteEditor } from "./NoteEditor";
import { noteMarkdownToDoc } from "./noteMarkdown";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const BROKEN = "data:image/png;base64,AAAA";
const image = "![Diagram](.attachments/0123456789abcdef.png)\n";

function setup(minted: string, remints: string[] = []) {
  state.minted = minted;
  state.remints = remints;
  state.remintCalls = 0;
  state.uploads = [];
  const saved: string[] = [];
  return { saved, onChange: (body: string) => saved.push(body) };
}

const editorUi = (body: string, onChange: (body: string) => void) => (
  <NoteEditor
    body={body}
    editable
    autoFocus
    onChange={onChange}
    embeds={{ environmentId: "env" as EnvironmentId, notePath: "plan.md", canAttach: true }}
  />
);

function paste(target: Element, data: { text?: string; files?: File[] }) {
  const transfer = new DataTransfer();
  if (data.text) transfer.setData("text/plain", data.text);
  for (const file of data.files ?? []) transfer.items.add(file);
  target.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
}

const body = (container: HTMLElement) => container.querySelector<HTMLElement>(".tiptap")!;

it("re-mints a failing note image once, then waits for the person to retry", async () => {
  const { onChange } = setup(BROKEN, ["data:image/png;base64,BBBB"]);
  await using screen = await render(editorUi(image, onChange));
  await expect.element(screen.getByText("Couldn’t load Diagram.")).toBeVisible();
  expect(state.remintCalls).toBe(1);
  await expect.element(screen.getByRole("button", { name: "Retry" })).toBeVisible();
});

it("recovers from each expiry after a successful load", async () => {
  const { onChange } = setup(BROKEN, [PNG, `${PNG}#2`]);
  await using screen = await render(editorUi(image, onChange));
  const img = () => screen.container.querySelector<HTMLImageElement>("img")!;
  await vi.waitFor(() => expect(img().src).toBe(PNG));
  await vi.waitFor(() => expect(img().complete && img().naturalWidth).toBe(1));
  await act(() => img().dispatchEvent(new Event("error")));
  await vi.waitFor(() => expect(img().src).toBe(`${PNG}#2`));
  expect(state.remintCalls).toBe(2);
  expect(screen.container.textContent).not.toContain("Couldn’t load");
});

it("turns a pasted video link on an empty line into a private player", async () => {
  const { saved, onChange } = setup(PNG);
  await using screen = await render(editorUi("", onChange));
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  await act(() => paste(body(screen.container), { text: url }));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ),
  );
  expect(saved.at(-1)?.trim()).toBe(url);
});

it("marks pasted files while they upload and inserts them in order after the line", async () => {
  const { saved, onChange } = setup(PNG);
  await using screen = await render(editorUi("Intro\n", onChange));
  const files = [
    new File(["a"], "a.png", { type: "image/png" }),
    new File(["b"], "Spec.pdf", { type: "application/pdf" }),
    new File(["c"], "clip.mp4", { type: "video/mp4" }),
  ];
  await act(() => paste(body(screen.container), { files }));
  await expect.element(screen.getByText("Uploading 3 files…")).toBeVisible();
  expect(state.uploads.map((upload) => upload.file.name)).toEqual([
    "a.png",
    "Spec.pdf",
    "clip.mp4",
  ]);
  const [a, spec, clip] = state.uploads;
  clip!.resolve({ ok: true, name: "clip.mp4", path: ".attachments/cccccccccccccccc.mp4" });
  spec!.resolve({ ok: true, name: "Spec.pdf", path: ".attachments/bbbbbbbbbbbbbbbb.pdf" });
  a!.resolve({ ok: true, name: "a.png", path: ".attachments/aaaaaaaaaaaaaaaa.png" });
  await vi.waitFor(() => expect(saved.at(-1)).toContain("clip"));
  const markdown = saved.at(-1)!;
  // Reloading the saved note shows the same three embeds.
  expect(
    noteMarkdownToDoc(markdown).content?.filter((node) => node.type === "noteEmbed"),
  ).toHaveLength(3);
  const order = [
    "Intro",
    "![a](/.attachments/aaaaaaaaaaaaaaaa.png)",
    "[Spec.pdf](/.attachments/bbbbbbbbbbbbbbbb.pdf)",
    "![clip](/.attachments/cccccccccccccccc.mp4)",
  ].map((part) => markdown.indexOf(part));
  expect(
    order.every(
      (index, position) => index >= 0 && (position === 0 || index > order[position - 1]!),
    ),
  ).toBe(true);
  await vi.waitFor(() => expect(screen.container.querySelector('img[alt="a"]')).not.toBeNull());
  await expect.element(screen.getByRole("button", { name: "Download Spec.pdf" })).toBeVisible();
  // The stub URL is a PNG, so the video element reports an error and offers a retry.
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector("video") ??
        [...screen.container.querySelectorAll("span")].find(
          (span) => span.textContent === "Couldn’t load clip.",
        ),
    ).toBeDefined(),
  );
  expect(screen.container.textContent).not.toContain("Uploading");
});

it("leaves the note as it was when an upload is cancelled or fails", async () => {
  const { saved, onChange } = setup(PNG);
  await using screen = await render(editorUi("Keep this\n", onChange));
  await act(() =>
    paste(body(screen.container), { files: [new File(["a"], "a.png", { type: "image/png" })] }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const [cancelled] = state.uploads;
  expect(cancelled!.signal.aborted).toBe(true);
  cancelled!.resolve({ ok: false, name: "a.png", message: "Cancelled.", cancelled: true });
  await act(() =>
    paste(body(screen.container), { files: [new File(["b"], "b.png", { type: "image/png" })] }),
  );
  state.uploads[1]!.resolve({ ok: false, name: "b.png", message: "Too big.", cancelled: false });
  await vi.waitFor(() => expect(screen.container.textContent).not.toContain("Uploading"));
  // Mounting with autofocus reports the unchanged body once; nothing else may be saved.
  expect(saved.every((saved) => saved === "Keep this\n")).toBe(true);
  expect(body(screen.container).textContent).toBe("Keep this");
});
