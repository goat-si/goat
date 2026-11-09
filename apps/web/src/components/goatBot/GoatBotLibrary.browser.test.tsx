import {
  ChannelGatewayError,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ChannelReadBotArtifactInput,
} from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  supported: true,
  data: null as unknown,
  failure: null as unknown,
  refresh: vi.fn(),
  requested: vi.fn(),
  files: new Map<string, { mimeType: string; bytes: Uint8Array }>(),
  read: vi.fn(),
  gate: null as Promise<void> | null,
  answered: 0,
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([["env", { environment: { capabilities: { goatBotLibrary: state.supported } } }]]),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    listBotArtifacts: (target: unknown) => {
      state.requested(target);
      return "artifacts";
    },
    readBotArtifact: { tag: "read" },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : state.data,
    failure: atom === null ? null : state.failure,
    error: state.failure === null ? null : "failed",
    isPending: false,
    isSuccess: state.data !== null,
    refresh: state.refresh,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => state.read,
}));
import { GoatBotLibrary } from "./GoatBotLibrary";

const environmentId = EnvironmentId.make("env");
const listing = (names: string[], truncated = false) => ({
  artifacts: names.map((relativePath, index) => ({
    relativePath,
    size: 1536,
    modifiedAt: `2026-11-0${7 - index}T10:00:00.000Z`,
  })),
  truncated,
});
function setup(options: { data?: unknown; failure?: unknown; supported?: boolean } = {}) {
  state.supported = options.supported ?? true;
  state.data =
    options.data === undefined
      ? listing(["notes/report.txt", "chart.png", "deck.pdf"])
      : options.data;
  state.failure = options.failure ?? null;
  state.refresh.mockReset();
  state.requested.mockReset();
  state.gate = null;
  state.answered = 0;
  state.files = new Map([
    [
      "notes/report.txt",
      { mimeType: "text/plain", bytes: new TextEncoder().encode("Weekly report") },
    ],
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

it("an older server is not asked for files", async () => {
  setup({ supported: false });
  await using screen = await render(<GoatBotLibrary environmentId={environmentId} />);
  await expect.element(screen.getByText("Files need a newer GOAT server.")).toBeVisible();
  expect(state.requested).not.toHaveBeenCalled();
});

it("says when GOAT Bot has saved nothing yet", async () => {
  setup({ data: listing([]) });
  await using screen = await render(<GoatBotLibrary environmentId={environmentId} />);
  await expect.element(screen.getByText("No files yet")).toBeVisible();
});

it("lists files newest first with folder and size, and says when the list is cut short", async () => {
  setup({ data: listing(["notes/report.txt", "chart.png"], true) });
  await using screen = await render(<GoatBotLibrary environmentId={environmentId} />);
  const rows = [...screen.container.querySelectorAll("li")].map((row) => row.textContent ?? "");
  expect(rows[0]).toContain("report.txt");
  expect(rows[0]).toContain("notes");
  expect(rows[0]).toContain("1.5 KB");
  expect(rows[1]).toContain("chart.png");
  await expect.element(screen.getByText("Showing the newest files only.")).toBeVisible();
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it.each([
  {
    name: "missing filesystem read",
    failure: new EnvironmentAuthorizationError({ message: "no", requiredScope: "filesystem:read" }),
    copy: "This device can't read GOAT Bot's files.",
    retry: false,
  },
  {
    name: "not GOAT Bot's home",
    failure: new ChannelGatewayError({ reason: "not_home" }),
    copy: "GOAT Bot's files are on its home computer.",
    retry: false,
  },
  {
    name: "other failure",
    failure: new Error("socket"),
    copy: "Couldn't load GOAT Bot's files.",
    retry: true,
  },
])("shows why files cannot load: $name", async ({ failure, copy, retry }) => {
  setup({ data: null, failure });
  await using screen = await render(<GoatBotLibrary environmentId={environmentId} />);
  await expect.element(screen.getByText(copy)).toBeVisible();
  const again = screen.getByRole("button", { name: "Try again" });
  if (!retry) {
    expect(again.query()).toBeNull();
    return;
  }
  state.refresh.mockClear();
  await userEvent.click(again);
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("opens a text file in a preview", async () => {
  setup();
  await using screen = await render(<GoatBotLibrary environmentId={environmentId} />);
  await userEvent.click(screen.getByRole("button", { name: "Open report.txt" }));
  await expect.element(page.getByRole("dialog", { name: "report.txt" })).toBeVisible();
  await expect.element(page.getByText("Weekly report")).toBeVisible();
});

it("opens an image in a preview and lets its URL go when the preview closes", async () => {
  setup();
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  await using screen = await render(<GoatBotLibrary environmentId={environmentId} />);
  await userEvent.click(screen.getByRole("button", { name: "Open chart.png" }));
  const image = page.getByRole("img", { name: "chart.png" });
  await expect.element(image).toBeVisible();
  const url = image.element().getAttribute("src") ?? "";
  expect(url.startsWith("blob:")).toBe(true);
  expect(revoke).not.toHaveBeenCalledWith(url);
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(url));
  revoke.mockRestore();
});

it("downloads any other file and lets its URL go after the click", async () => {
  setup();
  const clicked: string[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this.download);
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  await using screen = await render(<GoatBotLibrary environmentId={environmentId} />);
  await userEvent.click(screen.getByRole("button", { name: "Open deck.pdf" }));
  await vi.waitFor(() => expect(clicked).toEqual(["deck.pdf"]));
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
  click.mockRestore();
  revoke.mockRestore();
});

it("says why a file did not open", async () => {
  setup();
  state.files.delete("deck.pdf");
  await using screen = await render(<GoatBotLibrary environmentId={environmentId} />);
  await userEvent.click(screen.getByRole("button", { name: "Open deck.pdf" }));
  await expect
    .element(screen.getByText("Another file is still opening. Try again in a moment."))
    .toBeVisible();
});

it("opens one file at a time", async () => {
  setup();
  let release = () => {};
  state.gate = new Promise((resolve) => {
    release = resolve;
  });
  await using screen = await render(<GoatBotLibrary environmentId={environmentId} />);
  await userEvent.click(screen.getByRole("button", { name: "Open report.txt" }));
  await expect.element(screen.getByRole("button", { name: "Open chart.png" })).toBeDisabled();
  release();
  await expect.element(page.getByRole("dialog", { name: "report.txt" })).toBeVisible();
});
it("a file that finishes opening after the tab closes neither previews nor downloads", async () => {
  setup();
  let release = () => {};
  state.gate = new Promise((resolve) => {
    release = resolve;
  });
  const create = vi.spyOn(URL, "createObjectURL");
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const screen = await render(<GoatBotLibrary environmentId={environmentId} />);
  await userEvent.click(screen.getByRole("button", { name: "Open chart.png" }));
  await screen[Symbol.asyncDispose]();
  release();
  await vi.waitFor(() => expect(state.answered).toBe(1));
  await Promise.resolve();
  expect(create).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
  create.mockRestore();
  click.mockRestore();
});
