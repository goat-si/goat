import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  ChannelGatewayError,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ChannelReadBotArtifactInput,
} from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";

const fs = vi.hoisted(() => ({
  directories: new Set<string>(),
  written: new Map<string, Uint8Array>(),
  deleted: [] as string[],
}));
const state = vi.hoisted(() => ({
  data: null as unknown,
  cause: null as unknown,
  refresh: vi.fn(),
  requested: vi.fn(),
  files: new Map<string, { mimeType: string; bytes: Uint8Array }>(),
  gate: null as Promise<void> | null,
  answered: 0,
  share: vi.fn(),
  available: vi.fn(),
}));
vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(...parts: Array<string | Directory>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get name(): string {
      return this.uri.split("/").at(-1)!;
    }
    get exists(): boolean {
      return fs.directories.has(this.uri);
    }
    create(): void {
      fs.directories.add(this.uri);
    }
    list(): Directory[] {
      return [];
    }
    delete(): void {
      fs.deleted.push(this.uri);
      fs.directories.delete(this.uri);
      for (const uri of fs.written.keys())
        if (uri.startsWith(`${this.uri}/`)) fs.written.delete(uri);
    }
  }
  class File {
    readonly uri: string;
    constructor(source: Directory | string, name?: string) {
      this.uri = typeof source === "string" ? source : `${source.uri}/${encodeURIComponent(name!)}`;
    }
    write(bytes: Uint8Array): void {
      fs.written.set(this.uri, bytes);
    }
  }
  return { Directory, File, Paths: { cache: "file:///cache" } };
});
vi.mock("expo-sharing", () => ({ isAvailableAsync: state.available, shareAsync: state.share }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "00000000-0000-4000-8000-000000000000" }));
// A fixed "now", so the day headings do not depend on when the test runs.
const LIBRARY_NOW = Date.parse("2026-11-08T12:00:00.000Z");
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => LIBRARY_NOW }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Image: ({
    source,
    accessibilityLabel,
  }: {
    source: { uri: string };
    accessibilityLabel?: string;
  }) => <img src={source.uri} alt={accessibilityLabel} />,
  Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
    visible ? <section aria-label="Preview">{children}</section> : null,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => (
    <button onClick={onPress} disabled={disabled} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listBotArtifacts: (target: unknown) => {
      state.requested(target);
      return "artifacts";
    },
    readBotArtifact: {},
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : state.data,
    cause: atom === null ? null : state.cause,
    error: state.cause === null ? null : "failed",
    isPending: false,
    isSuccess: state.data !== null,
    refresh: state.refresh,
  }),
}));
vi.mock("@goat/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@goat/client-runtime/state/runtime")>()),
  runAtomCommand: async (
    _registry: unknown,
    _command: unknown,
    { input }: { input: ChannelReadBotArtifactInput },
  ) => {
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
  },
}));
import { MobileBotLibrary } from "./MobileBotLibrary";

const environmentId = EnvironmentId.make("env");
const pdf = new Uint8Array([37, 80, 68, 70]);
const png = new Uint8Array([137, 80, 78, 71]);
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});
function setup(options: { data?: unknown; cause?: unknown } = {}) {
  state.data =
    options.data === undefined
      ? {
          artifacts: [
            { relativePath: "deck.pdf", size: 4, modifiedAt: "2026-11-07T10:00:00.000Z" },
            { relativePath: "charts/chart.png", size: 4, modifiedAt: "2026-11-06T10:00:00.000Z" },
          ],
          truncated: false,
        }
      : options.data;
  state.cause = options.cause ?? null;
  state.refresh.mockReset();
  state.requested.mockReset();
  state.gate = null;
  state.answered = 0;
  state.files = new Map([
    ["deck.pdf", { mimeType: "application/pdf", bytes: pdf }],
    ["charts/chart.png", { mimeType: "image/png", bytes: png }],
  ]);
  state.share.mockReset();
  state.share.mockResolvedValue(undefined);
  state.available.mockReset();
  state.available.mockResolvedValue(true);
  fs.directories.clear();
  fs.written.clear();
  fs.deleted = [];
}
type Props = Partial<Parameters<typeof MobileBotLibrary>[0]>;
async function render(props: Props = {}) {
  document.body.appendChild(container);
  if (!root) root = createRoot(container);
  await act(async () =>
    root?.render(<MobileBotLibrary environmentId={environmentId} connected supported {...props} />),
  );
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
async function press(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(async () => target?.click());
  // A row is disabled while a file opens; the open is over when none is.
  await vi.waitFor(async () => {
    await act(async () => {});
    expect([...container.querySelectorAll("button")].some((item) => item.disabled)).toBe(false);
  });
}
const kept = () => [...fs.written.keys()];

it("lists files newest first with their size", async () => {
  setup();
  await render();
  const text = container.textContent ?? "";
  expect(text.indexOf("deck.pdf")).toBeLessThan(text.indexOf("chart.png"));
  expect(text).toContain("4 B");
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("says when GOAT Bot has saved nothing yet, and when the server is older", async () => {
  setup({ data: { artifacts: [], truncated: false } });
  await render();
  expect(container.textContent).toContain("Files GOAT Bot saves will appear here.");
  await render({ supported: false });
  expect(container.textContent).toContain("Files need a newer GOAT server.");
});

it("offline says so and loads once GOAT Bot is back", async () => {
  setup();
  await render({ connected: false });
  expect(container.textContent).toContain("Files are unavailable while GOAT Bot is offline.");
  expect(state.requested).not.toHaveBeenCalled();
  await render({ connected: true });
  expect(container.textContent).toContain("deck.pdf");
});

it.each([
  {
    name: "missing filesystem read",
    cause: new EnvironmentAuthorizationError({ message: "no", requiredScope: "filesystem:read" }),
    copy: "This device can't read GOAT Bot's files.",
    retry: false,
  },
  {
    name: "not GOAT Bot's home",
    cause: new ChannelGatewayError({ reason: "not_home" }),
    copy: "GOAT Bot's files are on its home computer.",
    retry: false,
  },
  {
    name: "other failure",
    cause: new Error("socket"),
    copy: "Couldn't load GOAT Bot's files.",
    retry: true,
  },
])("shows why files cannot load: $name", async ({ cause, copy, retry }) => {
  setup({ data: null, cause });
  await render();
  expect(container.textContent).toContain(copy);
  expect(button("Try again") !== undefined).toBe(retry);
});

it("a shared file goes to the share sheet and its copy stays for the receiving app", async () => {
  setup();
  await render();
  await press("Open deck.pdf");
  expect(state.share).toHaveBeenCalledWith(
    expect.stringContaining("deck.pdf"),
    expect.objectContaining({ mimeType: "application/pdf", dialogTitle: "deck.pdf" }),
  );
  expect([...fs.written.values()]).toEqual([pdf]);
  expect(fs.deleted).toEqual([]);
});

it("a share that fails says so and deletes the copy", async () => {
  setup();
  state.share.mockRejectedValue(new Error("no"));
  await render();
  await press("Open deck.pdf");
  expect(container.textContent).toContain("Could not open the share sheet. Try again.");
  expect(kept()).toEqual([]);
  expect(fs.deleted).toHaveLength(1);
});

it("leaving while a file is still opening keeps nothing", async () => {
  setup();
  let release = () => {};
  state.gate = new Promise((resolve) => {
    release = resolve;
  });
  await render();
  const open = button("Open deck.pdf");
  await act(async () => open?.click());
  await act(async () => root?.unmount());
  root = undefined;
  await act(async () => release());
  await vi.waitFor(() => expect(state.answered).toBe(1));
  await act(async () => {});
  expect(kept()).toEqual([]);
  expect(state.share).not.toHaveBeenCalled();
});

it("an image opens in the app and closing it deletes the copy", async () => {
  setup();
  await render();
  await press("Open chart.png");
  const image = container.querySelector("img");
  expect(image?.getAttribute("alt")).toBe("chart.png");
  expect(fs.written.get(image?.getAttribute("src") ?? "")).toEqual(png);
  await press("Close");
  expect(container.querySelector("img")).toBeNull();
  expect(kept()).toEqual([]);
});

it("an image shared from its preview keeps its copy after closing", async () => {
  setup();
  await render();
  await press("Open chart.png");
  await press("Share");
  expect(state.share).toHaveBeenCalledTimes(1);
  await press("Close");
  expect(kept()).toHaveLength(1);
});

it("leaving with an image preview open deletes the copy", async () => {
  setup();
  await render();
  await press("Open chart.png");
  expect(kept()).toHaveLength(1);
  await act(async () => root?.unmount());
  root = undefined;
  expect(kept()).toEqual([]);
});

it("says why a file did not open", async () => {
  setup();
  state.files.delete("deck.pdf");
  await render();
  await press("Open deck.pdf");
  expect(container.textContent).toContain("Another file is still opening. Try again in a moment.");
});

it("says when this device cannot share files", async () => {
  setup();
  state.available.mockResolvedValue(false);
  await render();
  await press("Open deck.pdf");
  expect(container.textContent).toContain("Sharing isn't available on this device.");
  expect(kept()).toEqual([]);
});
it("an image preview says why sharing did not start", async () => {
  setup();
  state.available.mockResolvedValue(false);
  await render();
  await press("Open chart.png");
  await press("Share");
  expect(container.textContent).toContain(
    "Saving and sharing files is unavailable on this device.",
  );
  state.available.mockResolvedValue(true);
  state.share.mockRejectedValue(new Error("no"));
  await press("Share");
  expect(container.textContent).toContain("Could not open the share sheet. Try again.");
});

it("puts the files under a heading for each day they were saved", async () => {
  setup();
  await render();
  const { goatBotDayLabel } = await import("@goat/client-runtime/goatBot");
  const text = container.textContent ?? "";
  const first = goatBotDayLabel("2026-11-07T10:00:00.000Z", LIBRARY_NOW);
  const second = goatBotDayLabel("2026-11-06T10:00:00.000Z", LIBRARY_NOW);
  expect(first).not.toBe(second);
  const order = [first, "deck.pdf", second, "chart.png"].map((part) => text.indexOf(part));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});
