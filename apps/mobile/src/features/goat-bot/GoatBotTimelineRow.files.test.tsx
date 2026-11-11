import { act } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";

const appearance = vi.hoisted(() => ({ mode: "light" as "light" | "dark", baseFontSize: 16 }));

vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("./MobileBotWork", () => ({ MobileBotWork: () => null }));
vi.mock("./useGoatBotEventTargets", () => ({
  useGoatBotEventTargets: () => ({ land: () => null, key: "" }),
}));
vi.mock("./GoatBotFace", async () => {
  const { Text } = await import("react-native");
  return {
    GoatBotHeaderFace: () => null,
    GoatBotProgressFace: (props: { state: string; inView: boolean }) => (
      <Text>{`face:${props.state}:${props.inView}|`}</Text>
    ),
  };
});
vi.mock("./GoatBotShimmerText", async () => {
  const { Text } = await import("react-native");
  return {
    GoatBotShimmerText: (props: { label: string; animate: boolean }) => (
      <Text>{`shimmer:${props.label}:${props.animate}`}</Text>
    ),
  };
});
// The real GoatBotMarkdown runs; only the native renderer under it is replaced by its source text,
// with each link's pill label and the long press it was given.
const native = vi.hoisted(() => ({
  longPress: null as null | ((url: string) => void),
  markdown: [] as string[],
}));
vi.mock("../../native/SelectableMarkdownText", async () => {
  const { Text } = await import("react-native");
  return {
    SelectableMarkdownText: (props: {
      markdown: string;
      linkCustomization?: (url: string) => { label?: string } | undefined;
      onLinkLongPress?: (url: string) => void;
    }) => {
      native.longPress = props.onLinkLongPress ?? null;
      native.markdown.push(props.markdown);
      const urls = [...new Set(props.markdown.match(/https?:\/\/[^\s<>)\]|]+/g) ?? [])];
      const pills = urls.flatMap((url) => {
        const label = props.linkCustomization?.(url)?.label;
        return label === undefined ? [] : [`pill[${url}=${label}]`];
      });
      return <Text>{`md[${props.markdown}]${pills.join("")}`}</Text>;
    },
  };
});
vi.mock("./GoatBotComposerAttachments", () => ({
  GoatBotAttachButton: () => null,
  GoatBotAttachmentStrip: () => null,
  releaseGoatBotAttachments: () => {},
}));
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext<number | undefined>(undefined),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: unknown }) => props.children },
  useAnimatedStyle: (style: () => object) => style(),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: () => null,
  useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({}) }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./useMobileGoatBotModel", () => ({ useMobileGoatBotModelMenu: () => null }));
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./GoatBotModelPill", () => ({ GoatBotModelPill: () => null }));
const clipboard = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => true) }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: clipboard.copy }));

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: appearance.mode,
    appearance: { baseFontSize: appearance.baseFontSize },
  }),
}));
// Opening a thread link reads the shell list; this test only reads what the reply shows.
vi.mock("../../state/threads", () => ({ environmentThreadShells: () => null }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));

// The Library this chat reads: what the listing holds, how often it was read, and each preview
// read as the server answers it.
const files = vi.hoisted(() => ({
  supported: true,
  connected: true,
  listing: null as null | { artifacts: object[]; truncated: boolean },
  pending: false,
  reads: 0,
  previews: [] as Array<{
    relativePath: string;
    answer: (value: object) => void;
  }>,
  opened: [] as string[],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          connection: { phase: files.connected ? "connected" : "disconnected" },
          serverConfig: { environment: { capabilities: { goatBotLibrary: files.supported } } },
        },
      ],
    ]),
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : files.listing,
    error: null,
    isPending: atom !== null && files.pending,
    refresh: () => {
      files.reads += 1;
    },
  }),
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listBotArtifacts: () => "listing",
    readBotArtifact: "read",
  },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => [] } }));
vi.mock("@goat/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@goat/client-runtime/state/runtime")>()),
  runAtomCommand: (
    _registry: unknown,
    _command: unknown,
    args: { input: { relativePath: string } },
  ) =>
    new Promise((resolve) => {
      files.previews.push({
        relativePath: args.input.relativePath,
        answer: (value) => resolve({ _tag: "Success", value }),
      });
    }),
}));
vi.mock("./openBotLibraryFile", () => ({
  openBotLibraryFile: async (_environmentId: string, relativePath: string) => {
    files.opened.push(relativePath);
    return {
      kind: "image",
      preview: {
        name: relativePath,
        file: { uri: "file:///cache/chart.png", dispose: () => {}, share: async () => {} },
      },
    };
  },
}));
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { GoatBotTimelineRow } from "./GoatBotScreen";
import { GoatBotFilesProvider } from "./GoatBotReplyFiles";

let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
  // Reads a test left unanswered settle, so the next test starts with a free server.
  for (const entry of files.previews)
    entry.answer({ status: "busy", relativePath: entry.relativePath });
  await settle();
  files.supported = true;
  files.connected = true;
  files.listing = null;
  files.pending = false;
  files.reads = 0;
  files.previews.length = 0;
  files.opened.length = 0;
});

const props = { canSend: true, onSend: () => true, onRetry: vi.fn(), onSelectThread: () => {} };
const at = "2026-11-12T01:00:00.000Z";
const file = (relativePath: string, size = 2048) => ({ relativePath, size, modifiedAt: at });
const bot = (id: string, text: string, options: string[] = []) => ({
  kind: "bot" as const,
  id,
  text,
  createdAt: "2026-10-12T09:40:00Z",
  tone: options.length > 0 ? ("question" as const) : ("reply" as const),
  proactive: false,
  replyTo: null,
  options,
  firstInGroup: true,
  groupPosition: "single" as const,
});
const settle = () => act(async () => {});
const chunk = (relativePath: string, mimeType: string, text: string) => ({
  status: "chunk",
  relativePath,
  mimeType,
  size: text.length,
  offset: 0,
  bytesBase64: btoa(unescape(encodeURIComponent(text))),
  version: "v1",
  done: true,
});

function chat(rows: ReturnType<typeof bot>[], threadId = "thread-a") {
  return (
    <GoatBotFilesProvider
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make(threadId)}
      botName="GOAT Bot"
    >
      {rows.map((row) => (
        <GoatBotTimelineRow key={row.id} {...props} row={row} />
      ))}
    </GoatBotFilesProvider>
  );
}
async function show(rows: ReturnType<typeof bot>[], threadId?: string) {
  h = createNativeMemoryHarness();
  view = renderNative(h, chat(rows, threadId));
  await view.render();
  await settle();
}
const card = (name: string) =>
  view.container.querySelector<HTMLButtonElement>(`button[aria-label="Open ${name}"]`);
const listed = (...paths: string[]) => ({
  artifacts: paths.map((path) => file(path)),
  truncated: false,
});

it("shows a card for a file the listing has, previews its words without media or links, and opens it in the Library's viewer", async () => {
  files.listing = listed("reports/report.md");
  await show([bot("b1", "Saved it to `reports/report.md`.")]);
  expect(card("report.md")).not.toBeNull();
  const read = files.previews.find((entry) => entry.relativePath === "reports/report.md");
  await act(async () =>
    read?.answer(
      chunk(
        "reports/report.md",
        "text/markdown",
        '# Weekly\n\nSee ![the chart](https://example.com/c.png) on [our site](https://example.com). <img src="https://example.com/x.png">',
      ),
    ),
  );
  const shown = card("report.md")?.textContent ?? "";
  expect(shown).toContain("See the chart on our site.");
  expect(shown).not.toContain("example.com");
  expect(view.container.querySelector('img[src^="http"]')).toBeNull();
  await act(async () => card("report.md")?.click());
  expect(files.opened).toEqual(["reports/report.md"]);
  // The same image viewer the Library opens, with its Close and Share.
  expect(view.container.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe(
    "file:///cache/chart.png",
  );
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain("Share");
});

it("draws an image preview from the chunk's own data", async () => {
  files.listing = listed("chart.png");
  await show([bot("b1", "Here: `chart.png`")]);
  const png = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
    0, 0, 0, 4, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0, 0, 0, 0,
    0,
  ];
  const base64 = btoa(String.fromCharCode(...png));
  await act(async () =>
    files.previews[0]?.answer({
      status: "chunk",
      relativePath: "chart.png",
      mimeType: "image/png",
      size: png.length,
      offset: 0,
      bytesBase64: base64,
      version: "v1",
      done: true,
    }),
  );
  expect(card("chart.png")?.querySelector("img")?.getAttribute("src")).toBe(
    `data:image/png;base64,${base64}`,
  );
});

it("shows no card for a file the listing lacks, plain inline code, an older server or no file named", async () => {
  files.listing = listed("reports/report.md");
  await show([
    bot("b1", "Run `npm test` first."),
    bot("b2", "It is in `quarterly report.md`."),
    bot("b3", "Nothing to open here."),
  ]);
  expect(view.container.querySelectorAll('button[aria-label^="Open "]')).toHaveLength(0);
  await view.unmount();
  h.dispose();
  files.supported = false;
  files.reads = 0;
  await show([bot("b1", "Saved it to `reports/report.md`.")]);
  expect(card("report.md")).toBeNull();
  expect(files.reads).toBe(0);
});

it("matches names with spaces and full artifact paths, and shows the card under a question too", async () => {
  files.listing = listed("quarterly report.md", "notes/README");
  await show([
    bot("b1", "See `/home/me/.goat/artifacts/quarterly report.md`."),
    bot("b2", "Which one? `notes/README`", ["Keep", "Drop"]),
  ]);
  expect(card("quarterly report.md")).not.toBeNull();
  expect(card("README")).not.toBeNull();
});

it("shows a card once a late listing names the file", async () => {
  files.listing = null;
  await show([bot("b1", "Saved `report.md`.")]);
  expect(card("report.md")).toBeNull();
  files.listing = listed("report.md");
  await view.rerender(chat([bot("b1", "Saved `report.md`.")]));
  await settle();
  expect(card("report.md")).not.toBeNull();
});

it("reads the listing again for a file named while a read was running, so a file saved meanwhile still gets its card", async () => {
  files.listing = listed("old.md");
  files.pending = true;
  await show([bot("b1", "Old: `old.md`.")]);
  const first = files.reads;
  expect(first).toBeGreaterThan(0);
  // A new reply names new.md while that read is still running.
  await view.rerender(chat([bot("b1", "Old: `old.md`."), bot("b2", "New: `new.md`.")]));
  await settle();
  expect(files.reads).toBe(first);
  // The running read answers without new.md (it was saved after the walk); a follow-up read starts.
  files.pending = false;
  files.listing = listed("old.md");
  await view.rerender(chat([bot("b1", "Old: `old.md`."), bot("b2", "New: `new.md`.")]));
  await settle();
  expect(files.reads).toBe(first + 1);
  files.listing = listed("old.md", "new.md");
  await view.rerender(chat([bot("b1", "Old: `old.md`."), bot("b2", "New: `new.md`.")]));
  await settle();
  expect(card("new.md")).not.toBeNull();
});

it("still reads for a newly named file after many replies with plain inline code", async () => {
  files.listing = listed();
  const plain = Array.from({ length: 12 }, (_, index) => bot(`p${index}`, `Run \`step${index}\`.`));
  await show(plain);
  const before = files.reads;
  files.listing = listed("fresh.md");
  await view.rerender(chat([...plain, bot("b1", "Saved `fresh.md`.")]));
  await settle();
  expect(files.reads).toBe(before + 1);
  await view.rerender(chat([...plain, bot("b1", "Saved `fresh.md`.")]));
  await settle();
  expect(card("fresh.md")).not.toBeNull();
});

it("drops a late preview answer once the chat changes", async () => {
  files.listing = listed("a.md");
  await show([bot("b1", "See \`a.md\`")]);
  expect(files.previews.map((entry) => entry.relativePath)).toEqual(["a.md"]);
  await view.rerender(chat([bot("b1", "See \`a.md\`")], "thread-b"));
  await settle();
  // The old chat's answer arrives late and lands nowhere.
  await act(async () => files.previews[0]?.answer(chunk("a.md", "text/markdown", "OLD CHAT")));
  await settle();
  expect(view.container.textContent).not.toContain("OLD CHAT");
});

it("never starts a waiting preview read once its card has left", async () => {
  files.listing = listed("a.md", "b.md");
  await show([bot("b1", "\`a.md\` and \`b.md\`")]);
  // One read runs at a time: a.md is in flight, b.md waits.
  expect(files.previews.map((entry) => entry.relativePath)).toEqual(["a.md"]);
  await view.unmount();
  await act(async () => files.previews[0]?.answer(chunk("a.md", "text/markdown", "x")));
  await settle();
  expect(files.previews.map((entry) => entry.relativePath)).toEqual(["a.md"]);
});

it("reads the listing again for a later mention of a listed file, so a rewritten file previews again", async () => {
  files.listing = listed("report.md");
  await show([bot("b1", "See `report.md`.")]);
  await act(async () =>
    files.previews[0]?.answer(chunk("report.md", "text/markdown", "Old words")),
  );
  expect(card("report.md")?.textContent).toContain("Old words");
  const before = files.reads;
  const previewsBefore = files.previews.length;
  // The bot rewrote the file and names it again; a new listing answer moves the generation.
  await view.rerender(chat([bot("b1", "See `report.md`."), bot("b2", "Updated `report.md`.")]));
  await settle();
  expect(files.reads).toBe(before + 1);
  files.listing = listed("report.md");
  await view.rerender(chat([bot("b1", "See `report.md`."), bot("b2", "Updated `report.md`.")]));
  await settle();
  expect(files.previews.length).toBeGreaterThan(previewsBefore);
  await act(async () => {
    for (const entry of files.previews.slice(previewsBefore))
      entry.answer(chunk("report.md", "text/markdown", "New words"));
  });
  await settle();
  expect(view.container.textContent).toContain("New words");
  expect(view.container.textContent).not.toContain("Old words");
});

it("counts the same file named again later in a streamed reply as a new mention", async () => {
  files.listing = listed();
  await show([bot("b1", "Saving `report.md` now.")]);
  const before = files.reads;
  files.pending = false;
  files.listing = listed("report.md");
  await view.rerender(chat([bot("b1", "Saving `report.md` now. Saved `report.md`.")]));
  await settle();
  expect(files.reads).toBe(before + 1);
  expect(card("report.md")).not.toBeNull();
});
