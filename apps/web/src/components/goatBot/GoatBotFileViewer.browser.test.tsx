import { botFileReads } from "@goat/client-runtime/goatBot";
import { EnvironmentId, type ChannelReadBotArtifactInput } from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  files: new Map<string, { mimeType: string; bytes: Uint8Array }>(),
  read: vi.fn(),
  gate: null as Promise<void> | null,
  answered: 0,
}));
vi.mock("~/state/channels", () => ({ channelEnvironment: { readBotArtifact: { tag: "read" } } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.read }));
import { GoatBotFileViewer } from "./GoatBotFileViewer";

const environmentId = EnvironmentId.make("env");
const fileFor = (relativePath: string) => ({
  relativePath,
  size: state.files.get(relativePath)?.bytes.length ?? 0,
  modifiedAt: "2026-11-07T10:00:00.000Z",
});

function setup() {
  // The read queue is one module instance; a read a test left waiting must not hold the next.
  botFileReads.clear();
  state.gate = null;
  state.answered = 0;
  const encode = (text: string) => new TextEncoder().encode(text);
  state.files = new Map([
    ["notes/report.txt", { mimeType: "text/plain", bytes: encode("Weekly report") }],
    ["summary.md", { mimeType: "text/markdown", bytes: encode("# Findings\n\n- one") }],
    ["chart.png", { mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }],
    ["deck.pdf", { mimeType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) }],
  ]);
  state.read.mockReset();
  state.read.mockImplementation(async ({ input }: { input: ChannelReadBotArtifactInput }) => {
    if (state.gate) await state.gate;
    state.answered += 1;
    const file = state.files.get(input.relativePath);
    if (!file)
      return { _tag: "Success", value: { status: "busy", relativePath: input.relativePath } };
    return {
      _tag: "Success",
      value: {
        status: "chunk",
        relativePath: input.relativePath,
        mimeType: file.mimeType,
        size: file.bytes.length,
        offset: 0,
        bytesBase64: Base64.encode(file.bytes),
        version: "v1",
        done: true,
      },
    };
  });
}

it("shows a text file as written and a markdown file rendered", async () => {
  setup();
  await using text = await render(
    <GoatBotFileViewer
      environmentId={environmentId}
      file={fileFor("notes/report.txt")}
      onClose={() => {}}
    />,
  );
  await expect.element(text.getByText("Weekly report")).toBeVisible();
  await using markdown = await render(
    <GoatBotFileViewer
      environmentId={environmentId}
      file={fileFor("summary.md")}
      onClose={() => {}}
    />,
  );
  await expect.element(markdown.getByRole("heading", { name: "Findings" })).toBeVisible();
});

it("shows an image and lets its URL go when the viewer closes", async () => {
  setup();
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const screen = await render(
    <GoatBotFileViewer
      environmentId={environmentId}
      file={fileFor("chart.png")}
      onClose={() => {}}
    />,
  );
  const image = screen.getByRole("img", { name: "chart.png" });
  await expect.element(image).toBeVisible();
  const url = image.element().getAttribute("src") ?? "";
  expect(url.startsWith("blob:")).toBe(true);
  expect(revoke).not.toHaveBeenCalledWith(url);
  await screen[Symbol.asyncDispose]();
  expect(revoke).toHaveBeenCalledWith(url);
  revoke.mockRestore();
});

it("offers a file it can't show as a download and lets that URL go after the click", async () => {
  setup();
  const clicked: string[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this.download);
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  await using screen = await render(
    <GoatBotFileViewer
      environmentId={environmentId}
      file={fileFor("deck.pdf")}
      onClose={() => {}}
    />,
  );
  await expect.element(screen.getByText("This file can't be shown here.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Download", exact: true }));
  expect(clicked).toEqual(["deck.pdf"]);
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
  click.mockRestore();
  revoke.mockRestore();
});

it("says why a file did not open and tries again", async () => {
  setup();
  const missing = { relativePath: "gone.txt", size: 1, modifiedAt: "2026-11-07T10:00:00.000Z" };
  await using screen = await render(
    <GoatBotFileViewer environmentId={environmentId} file={missing} onClose={() => {}} />,
  );
  await expect
    .element(screen.getByText("gone.txt is taking too long to open. Try again in a moment."))
    .toBeVisible();
  state.files.set("gone.txt", { mimeType: "text/plain", bytes: new TextEncoder().encode("Back") });
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await expect.element(screen.getByText("Back")).toBeVisible();
});

it("Escape and Close both close it", async () => {
  setup();
  const onClose = vi.fn();
  await using screen = await render(
    <GoatBotFileViewer
      environmentId={environmentId}
      file={fileFor("notes/report.txt")}
      onClose={onClose}
    />,
  );
  const close = screen.getByRole("button", { name: "Close report.txt" });
  await expect.element(close).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(close);
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("a file that finishes reading after the viewer closed makes no URL", async () => {
  setup();
  let release = () => {};
  state.gate = new Promise((resolve) => {
    release = resolve;
  });
  const create = vi.spyOn(URL, "createObjectURL");
  const screen = await render(
    <GoatBotFileViewer
      environmentId={environmentId}
      file={fileFor("chart.png")}
      onClose={() => {}}
    />,
  );
  await expect.element(screen.getByText("Opening…")).toBeVisible();
  await screen[Symbol.asyncDispose]();
  release();
  await vi.waitFor(() => expect(state.answered).toBe(1));
  await Promise.resolve();
  expect(create).not.toHaveBeenCalled();
  create.mockRestore();
});

it("a file opened right after another one closed waits for that read instead of finding the server busy", async () => {
  setup();
  // The server reads one file per connection at a time and answers busy to a second.
  let inFlight = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const serve = state.read.getMockImplementation();
  state.read.mockImplementation(async (request: { input: ChannelReadBotArtifactInput }) => {
    if (inFlight > 0)
      return {
        _tag: "Success",
        value: { status: "busy", relativePath: request.input.relativePath },
      };
    inFlight += 1;
    await gate;
    inFlight -= 1;
    return serve?.(request);
  });
  const first = await render(
    <GoatBotFileViewer
      environmentId={environmentId}
      file={fileFor("chart.png")}
      onClose={() => {}}
    />,
  );
  await vi.waitFor(() => expect(inFlight).toBe(1));
  await first[Symbol.asyncDispose]();
  await using second = await render(
    <GoatBotFileViewer
      environmentId={environmentId}
      file={fileFor("notes/report.txt")}
      onClose={() => {}}
    />,
  );
  release();
  await expect.element(second.getByText("Weekly report")).toBeVisible();
});
