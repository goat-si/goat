import { act, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));
import {
  createNativeMemoryHarness,
  renderNative,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";

const appearance = vi.hoisted(() => ({ mode: "light" as "light" | "dark", baseFontSize: 16 }));

// The screen's list draws every row it is given.
// Editing a member from its chat reads secure storage and bot permissions; these tests do not.
vi.mock("./MobileNewBotNameRow", () => ({
  useMobileBotEditing: () => ({ nameRow: null, editSheet: null, openEdit: undefined }),
}));
vi.mock("@legendapp/list/react-native", async () => {
  const { Fragment } = await import("react");
  return {
    LegendList: (props: {
      data?: Array<{ id: string }>;
      renderItem?: (item: { item: unknown; index: number }) => unknown;
    }) =>
      props.data?.map((item, index) => (
        <Fragment key={item.id}>{props.renderItem?.({ item, index }) as never}</Fragment>
      )) ?? null,
  };
});
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
  KeyboardAvoidingView: (props: { children?: unknown }) => props.children,
  useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
// The screen's session: whose chat it shows, and its rows.
const screenSession = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./useMobileGoatBotSession", () => ({
  useMobileGoatBotSession: () => screenSession.current,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: () => {} }),
  StackActions: { push: (name: string, params: object) => ({ name, params }) },
}));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => () => {},
  startOpeningDetail: () => {},
}));
vi.mock("../settings/SettingsMemoryRouteScreen", () => ({ MemoryReportLink: () => null }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
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
  listing: null as null | { artifacts: object[]; truncated: boolean; root?: string },
  pending: false,
  reads: 0,
  // Every read the server got and has not refused, in order. Like the server, it reads one file
  // per connection at a time: a read arriving while another is unanswered is answered busy.
  previews: [] as Array<{
    relativePath: string;
    answered: boolean;
    answer: (value: object) => void;
  }>,
  /** The real Library opener runs, reading through this server, instead of the stand-in. */
  realOpen: false,
  opened: [] as string[],
  // An open waits here until the test lets it finish; disposed copies are named here.
  holdOpens: false,
  finishOpen: [] as Array<() => void>,
  disposed: [] as string[],
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
    // Each listing answer is its own object, as the query's settled result is.
    successResult: atom === null || files.pending ? null : files.listing,
    cause: null,
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
  ) => {
    const relativePath = args.input.relativePath;
    if (files.previews.some((entry) => !entry.answered))
      return Promise.resolve({ _tag: "Success", value: { status: "busy", relativePath } });
    return new Promise((resolve) => {
      const entry = {
        relativePath,
        answered: false,
        answer: (value: object) => {
          if (entry.answered) return;
          entry.answered = true;
          resolve({ _tag: "Success", value });
        },
      };
      files.previews.push(entry);
    });
  },
}));
vi.mock("../../lib/attachmentDownload", () => ({
  writeGeneratedAttachmentFile: async (input: { attachment: { name: string } }) => ({
    uri: "file:///cache/opened.png",
    dispose: () => files.disposed.push(input.attachment.name),
    share: async () => {},
  }),
  shareGeneratedAttachment: async () => true,
}));
vi.mock("./openBotLibraryFile", async (original) => {
  const real = await original<typeof import("./openBotLibraryFile")>();
  return {
    openBotLibraryFile: (...args: Parameters<typeof real.openBotLibraryFile>) =>
      files.realOpen ? real.openBotLibraryFile(...args) : standInOpen(args[1]),
  };
});
async function standInOpen(relativePath: string) {
  {
    files.opened.push(relativePath);
    if (files.holdOpens) await new Promise<void>((resolve) => files.finishOpen.push(resolve));
    return {
      kind: "image",
      preview: {
        name: relativePath,
        file: {
          uri: "file:///cache/chart.png",
          dispose: () => files.disposed.push(relativePath),
          share: async () => {},
        },
      },
    } as const;
  }
}
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { botFileReads } from "@goat/client-runtime/goatBot";
import { GoatBotScreen, GoatBotTimelineRow } from "./GoatBotScreen";
import { chatFilesScope, GoatBotFilesProvider } from "./GoatBotReplyFiles";
import { useBotFileOpener } from "./MobileBotFileViewer";

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
  files.holdOpens = false;
  files.finishOpen.length = 0;
  files.disposed.length = 0;
  files.realOpen = false;
  screenSession.current = {};
});

// The shared Library read lane is one module instance; each test starts it empty.
function setup() {
  botFileReads.clear();
}

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
/** A reply sent after the ones the chat opened with. */
const later = (row: ReturnType<typeof bot>) => ({ ...row, createdAt: "2026-10-12T09:50:00Z" });
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

/** The chat's bot replies as the screen passes them: those in `streaming` are still arriving. */
const repliesOf = (rows: ReturnType<typeof bot>[], streaming: ReadonlyArray<string> = []) =>
  rows.map((row) => ({
    id: row.id,
    text: row.text,
    createdAt: row.createdAt,
    streaming: streaming.includes(row.id),
  }));

function chat(
  rows: ReturnType<typeof bot>[],
  threadId = "thread-a",
  streaming: ReadonlyArray<string> = [],
  shown: ReturnType<typeof bot>[] = rows,
) {
  return (
    <Chat threadId={threadId} replies={repliesOf(rows, streaming)}>
      {shown.map((row) => (
        <GoatBotTimelineRow key={row.id} {...props} row={row} />
      ))}
    </Chat>
  );
}
// The screen owns the chat's opener and hands it to the provider; this does the same.
function Chat(props: {
  threadId: string;
  replies: ReturnType<typeof repliesOf>;
  children: ReactNode;
}) {
  const environmentId = EnvironmentId.make("env");
  const threadId = ThreadId.make(props.threadId);
  const opener = useBotFileOpener(
    environmentId,
    "GOAT Bot",
    chatFilesScope(environmentId, threadId),
  );
  return (
    <GoatBotFilesProvider
      environmentId={environmentId}
      threadId={threadId}
      replies={props.replies}
      opener={opener}
    >
      {props.children}
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
  view.container.querySelector<HTMLButtonElement>(`button[aria-label^="Open ${name},"]`);
const listed = (...paths: string[]) => ({
  artifacts: paths.map((path) => file(path)),
  truncated: false,
});

it("shows a card for a file the listing has, previews its words without media or links, and opens it in the Library's viewer", async () => {
  setup();
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
  setup();
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
  setup();
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

it("reads no listing for inline code the Library cannot list, and reads one for a bare name like README", async () => {
  setup();
  files.listing = listed("README");
  const odd = bot("b1", "Open `https://example.com/a.md`, `.env` or `../up.md`; run `a:b`.");
  await show([odd]);
  expect(files.reads).toBe(0);
  await view.rerender(chat([odd, later(bot("b2", "See `README`."))]));
  await settle();
  expect(files.reads).toBe(1);
  expect(card("README")).not.toBeNull();
});

it("matches names with spaces and full artifact paths, and shows the card under a question too", async () => {
  setup();
  files.listing = {
    ...listed("quarterly report.md", "notes/README"),
    root: "/home/me/.goat/artifacts",
  };
  await show([
    bot("b1", "See `/home/me/.goat/artifacts/quarterly report.md`."),
    bot("b2", "Which one? `notes/README`", ["Keep", "Drop"]),
  ]);
  expect(card("quarterly report.md")).not.toBeNull();
  expect(card("README")).not.toBeNull();
});

it("shows a card once a late listing names the file", async () => {
  setup();
  files.listing = null;
  await show([bot("b1", "Saved `report.md`.")]);
  expect(card("report.md")).toBeNull();
  files.listing = listed("report.md");
  await view.rerender(chat([bot("b1", "Saved `report.md`.")]));
  await settle();
  expect(card("report.md")).not.toBeNull();
});

it("reads the listing again for a file named while a read was running, so a file saved meanwhile still gets its card", async () => {
  setup();
  files.listing = listed("old.md");
  files.pending = true;
  await show([bot("b1", "Old: `old.md`.")]);
  const first = files.reads;
  expect(first).toBeGreaterThan(0);
  // A new reply names new.md while that read is still running.
  await view.rerender(chat([bot("b1", "Old: `old.md`."), later(bot("b2", "New: `new.md`."))]));
  await settle();
  expect(files.reads).toBe(first);
  // The running read answers without new.md (it was saved after the walk); a follow-up read starts.
  files.pending = false;
  files.listing = listed("old.md");
  await view.rerender(chat([bot("b1", "Old: `old.md`."), later(bot("b2", "New: `new.md`."))]));
  await settle();
  expect(files.reads).toBe(first + 1);
  files.listing = listed("old.md", "new.md");
  await view.rerender(chat([bot("b1", "Old: `old.md`."), later(bot("b2", "New: `new.md`."))]));
  await settle();
  expect(card("new.md")).not.toBeNull();
});

it("still reads for a newly named file after many replies with plain inline code", async () => {
  setup();
  files.listing = listed();
  const plain = Array.from({ length: 12 }, (_, index) => bot(`p${index}`, `Run \`step${index}\`.`));
  await show(plain);
  const before = files.reads;
  files.listing = listed("fresh.md");
  await view.rerender(chat([...plain, later(bot("b1", "Saved `fresh.md`."))]));
  await settle();
  expect(files.reads).toBe(before + 1);
  await view.rerender(chat([...plain, later(bot("b1", "Saved `fresh.md`."))]));
  await settle();
  expect(card("fresh.md")).not.toBeNull();
});

it("drops a late preview answer once the chat changes", async () => {
  setup();
  files.listing = listed("a.md");
  await show([bot("b1", "See `a.md`")]);
  expect(files.previews.map((entry) => entry.relativePath)).toEqual(["a.md"]);
  await view.rerender(chat([bot("b1", "See `a.md`")], "thread-b"));
  await settle();
  // The old chat's answer arrives late and lands nowhere.
  await act(async () => files.previews[0]?.answer(chunk("a.md", "text/markdown", "OLD CHAT")));
  await settle();
  expect(view.container.textContent).not.toContain("OLD CHAT");
});

it("never starts a waiting preview read once its card has left", async () => {
  setup();
  files.listing = listed("a.md", "b.md");
  await show([bot("b1", "`a.md` and `b.md`")]);
  // One read runs at a time: a.md is in flight, b.md waits.
  expect(files.previews.map((entry) => entry.relativePath)).toEqual(["a.md"]);
  await view.unmount();
  await act(async () => files.previews[0]?.answer(chunk("a.md", "text/markdown", "x")));
  await settle();
  expect(files.previews.map((entry) => entry.relativePath)).toEqual(["a.md"]);
});

it("reads the listing again for a later mention of a listed file, so a rewritten file previews again", async () => {
  setup();
  const first = bot("b1", "See `report.md`.");
  const later = { ...bot("b2", "Updated `report.md`."), createdAt: "2026-10-12T09:50:00Z" };
  // Answers every read so far, then the one that was waiting behind them.
  const answerPreviews = async (words: string) => {
    for (let round = 0; round < 2; round += 1)
      await act(async () => {
        for (const entry of files.previews)
          entry.answer(chunk("report.md", "text/markdown", words));
      });
  };
  files.listing = listed("report.md");
  await show([first]);
  // The chat's first read answers.
  files.listing = listed("report.md");
  await view.rerender(chat([first]));
  await settle();
  await answerPreviews("Old words");
  expect(card("report.md")?.textContent).toContain("Old words");
  const before = files.reads;
  const previewsBefore = files.previews.length;
  // The bot rewrote the file and names it again; a new listing answer moves the generation.
  await view.rerender(chat([first, later]));
  await settle();
  expect(files.reads).toBe(before + 1);
  files.listing = listed("report.md");
  await view.rerender(chat([first, later]));
  await settle();
  expect(files.previews.length).toBeGreaterThan(previewsBefore);
  await answerPreviews("New words");
  await settle();
  expect(view.container.textContent).toContain("New words");
  expect(view.container.textContent).not.toContain("Old words");
});

it("reads the listing exactly once for a reply that streams 50 file names and then finishes", async () => {
  setup();
  files.listing = listed();
  const spans = (count: number) =>
    Array.from({ length: count }, (_, index) => `\`step${index}.md\``).join(" ");
  h = createNativeMemoryHarness();
  view = renderNative(h, chat([bot("b1", spans(1))], "thread-a", ["b1"]));
  await view.render();
  await settle();
  for (let count = 2; count <= 50; count += 1) {
    files.listing = listed();
    await view.rerender(chat([bot("b1", spans(count))], "thread-a", ["b1"]));
    await settle();
  }
  expect(files.reads).toBe(0);
  files.listing = listed("step49.md");
  await view.rerender(chat([bot("b1", spans(50))]));
  await settle();
  expect(files.reads).toBe(1);
  expect(card("step49.md")).not.toBeNull();
});

it("reads nothing more when history rows mount again, or an older or same-time reply arrives after a read", async () => {
  setup();
  files.listing = listed("a.md");
  const history = Array.from({ length: 30 }, (_, index) =>
    bot(`h${index}`, `Saved \`f${index}.md\`.`),
  ).map((row, index) => ({ ...row, createdAt: `2026-10-12T09:${String(10 + index)}:00Z` }));
  await show(history);
  const opened = files.reads;
  expect(opened).toBe(1);
  // That read answers, so anything owed from here would start another.
  files.listing = listed("a.md");
  await view.rerender(chat(history));
  await settle();
  // Scrolling away and back unmounts the rows' cards and mounts them again.
  await view.rerender(chat(history, "thread-a", [], []));
  await settle();
  await view.rerender(chat(history, "thread-a", [], history));
  await settle();
  // An older page of history loads.
  const older = { ...bot("old", "Earlier: `g.md`."), createdAt: "2026-10-12T08:00:00Z" };
  await view.rerender(chat([older, ...history]));
  await settle();
  // One from the same moment as the newest reply that read covered.
  const sameTime = { ...bot("same", "Also `h.md`."), createdAt: history.at(-1)?.createdAt ?? "" };
  await view.rerender(chat([older, ...history, sameTime]));
  await settle();
  expect(files.reads).toBe(opened);
});

it("names the file's kind to a screen reader", async () => {
  setup();
  files.listing = listed("report.md", "chart.png", "data.csv");
  await show([bot("b1", "`report.md`, `chart.png` and `data.csv`")]);
  const labels = [...view.container.querySelectorAll('button[aria-label^="Open "]')].map((button) =>
    button.getAttribute("aria-label"),
  );
  expect(labels).toEqual([
    "Open report.md, Markdown file",
    "Open chart.png, Image",
    // Named from the file's name before its preview is read, as its read would name it.
    "Open data.csv, Text file",
  ]);
});

// The real screen around the rows, for what happens when its chat changes in place.
function screenFor(threadId: string, rows: ReturnType<typeof bot>[]) {
  screenSession.current = {
    availability: "ready",
    rows,
    canSend: true,
    attachmentSupport: { maxUploadBytes: null },
    onSend: () => true,
    onAnswer: () => true,
    onRetryInput: () => {},
    replyingSince: null,
    activity: null,
    supportsTaskThreads: false,
    historyEnvironmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make(threadId),
    streamingReplyIds: new Set<string>(),
    visibleTurnItems: [],
    boundedSnapshots: false,
  };
  return <GoatBotScreen visible />;
}
const dialogImage = () => view.container.querySelector('[role="dialog"] img');

it("drops an open still reading when the chat changes, and closes a shown image", async () => {
  setup();
  files.listing = listed("chart.png");
  const rows = [bot("b1", "Here: `chart.png`")];
  h = createNativeMemoryHarness();
  view = renderNative(h, screenFor("thread-a", rows));
  await view.render();
  await settle();
  files.holdOpens = true;
  await act(async () => card("chart.png")?.click());
  expect(files.opened).toEqual(["chart.png"]);
  // The person switches to another bot's chat on the same screen before the file arrives.
  await view.rerender(screenFor("thread-b", rows));
  await settle();
  await act(async () => files.finishOpen.shift()?.());
  await settle();
  expect(dialogImage()).toBeNull();
  expect(files.disposed).toEqual(["chart.png"]);
  // An image already shown closes when the chat changes.
  files.holdOpens = false;
  await act(async () => card("chart.png")?.click());
  await settle();
  expect(dialogImage()).not.toBeNull();
  await view.rerender(screenFor("thread-c", rows));
  await settle();
  expect(dialogImage()).toBeNull();
  expect(files.disposed).toEqual(["chart.png", "chart.png"]);
});

const pngBytes = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
  0, 0, 0, 4, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0, 0, 0, 0, 0,
];
const pngChunk = (relativePath: string) => ({
  status: "chunk",
  relativePath,
  mimeType: "image/png",
  size: pngBytes.length,
  offset: 0,
  bytesBase64: btoa(String.fromCharCode(...pngBytes)),
  version: "v1",
  done: true,
});
/** The server's next unanswered read, which must be for `path`. */
async function answerNext(path: string, value: object) {
  const entry = files.previews.find((read) => !read.answered);
  expect(entry?.relativePath).toBe(path);
  await act(async () => entry?.answer(value));
  await settle();
}
const FAILED = /taking too long|Couldn't open/;

it("opens a card tapped while its own preview is loading once that chunk is in, with no error, and keeps the preview", async () => {
  setup();
  files.realOpen = true;
  files.listing = listed("chart.png");
  await show([bot("b1", "Here: `chart.png`")]);
  await act(async () => card("chart.png")?.click());
  await settle();
  // Nothing overlaps on the connection: the preview's chunk comes in, then the open reads.
  await answerNext("chart.png", pngChunk("chart.png"));
  expect(card("chart.png")?.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png/);
  await answerNext("chart.png", pngChunk("chart.png"));
  expect(view.container.textContent).not.toMatch(FAILED);
  expect(dialogImage()?.getAttribute("src")).toBe("file:///cache/opened.png");
});

it("runs a tapped card's open right after the preview in flight, ahead of the previews still waiting", async () => {
  setup();
  files.realOpen = true;
  files.listing = listed("report.md", "chart.png", "notes.md");
  await show([bot("b1", "`report.md`, `chart.png` and `notes.md`")]);
  // report.md's preview is in flight; chart.png's and notes.md's wait.
  await act(async () => card("notes.md")?.click());
  await settle();
  await answerNext("report.md", chunk("report.md", "text/markdown", "Weekly words"));
  // The open goes next; it shares a Markdown file.
  await answerNext("notes.md", chunk("notes.md", "text/markdown", "Notes"));
  expect(view.container.textContent).not.toMatch(FAILED);
  expect(card("notes.md")?.textContent).not.toContain("Opening");
  // The waiting previews run newest first.
  await answerNext("notes.md", chunk("notes.md", "text/markdown", "Notes preview"));
  await answerNext("chart.png", pngChunk("chart.png"));
  expect(card("report.md")?.textContent).toContain("Weekly words");
  expect(card("chart.png")?.querySelector("img")).not.toBeNull();
  expect(card("notes.md")?.textContent).toContain("Notes preview");
});
it("shows Preview unavailable in the slot when a preview fails or has nothing to show, and the card still opens", async () => {
  setup();
  files.listing = listed("report.md", "chart.png");
  await show([bot("b1", "`report.md` and `chart.png`")]);
  // chart.png's bytes are a GIF under a PNG name, so there is nothing to draw; report.md is busy.
  for (let read = 0; read < 2; read += 1) {
    const next = files.previews.find((entry) => !entry.answered)?.relativePath ?? "";
    await answerNext(
      next,
      next === "chart.png"
        ? chunk("chart.png", "image/png", "GIF89a not a png")
        : { status: "busy", relativePath: next },
    );
  }
  expect(card("report.md")?.textContent).toContain("Preview unavailable");
  expect(card("chart.png")?.textContent).toContain("Preview unavailable");
  await act(async () => card("report.md")?.click());
  await settle();
  expect(files.opened).toEqual(["report.md"]);
});

it("says a busy open is taking too long, in the words both clients use", async () => {
  setup();
  files.realOpen = true;
  files.listing = listed("report.md");
  await show([bot("b1", "Here: `report.md`")]);
  await answerNext("report.md", chunk("report.md", "text/markdown", "Weekly words"));
  await act(async () => card("report.md")?.click());
  await settle();
  await answerNext("report.md", { status: "busy", relativePath: "report.md" });
  expect(view.container.textContent).toContain(
    "report.md is taking too long to open. Try again in a moment.",
  );
  expect(view.container.textContent).not.toContain("Another file is still opening");
  expect(card("report.md")?.textContent).not.toContain("Opening");
});
it("leaves no card stuck on Opening after its open is stopped by a chat change and the person comes back", async () => {
  setup();
  files.realOpen = true;
  files.listing = listed("report.md");
  const rows = [bot("b1", "Here: `report.md`")];
  await show(rows);
  // report.md's preview is in flight; the open waits behind it.
  await act(async () => card("report.md")?.click());
  await settle();
  expect(card("report.md")?.textContent).toContain("Opening");
  await view.rerender(chat(rows, "thread-b"));
  await settle();
  await view.rerender(chat(rows, "thread-a"));
  await settle();
  expect(card("report.md")?.textContent).not.toContain("Opening");
  expect(card("report.md")?.disabled).toBe(false);
});
it("remembers a preview with nothing to show for the file's version, and asks again after a failed read or for a new version", async () => {
  setup();
  files.listing = listed("broken.png", "busy.md");
  const rows = [bot("b1", "`broken.png` and `busy.md`")];
  await show(rows);
  for (let read = 0; read < 2; read += 1) {
    const next = files.previews.find((entry) => !entry.answered)?.relativePath ?? "";
    await answerNext(
      next,
      next === "broken.png"
        ? chunk("broken.png", "image/png", "GIF89a not a png")
        : { status: "busy", relativePath: next },
    );
  }
  const asked = (path: string) => files.previews.filter((entry) => entry.relativePath === path);
  expect(asked("broken.png")).toHaveLength(1);
  expect(asked("busy.md")).toHaveLength(1);
  // The rows scroll away and back in the same chat: the empty answer is remembered, the failed one asked again.
  await view.rerender(chat(rows, "thread-a", [], []));
  await settle();
  await view.rerender(chat(rows));
  await settle();
  expect(card("broken.png")?.textContent).toContain("Preview unavailable");
  await answerNext("busy.md", chunk("busy.md", "text/markdown", "Back now"));
  expect(asked("broken.png")).toHaveLength(1);
  expect(asked("busy.md")).toHaveLength(2);
  // A new listing answer is a new version of the files: the empty one is asked again.
  files.listing = listed("broken.png", "busy.md");
  await view.rerender(chat(rows));
  await settle();
  expect(asked("broken.png")).toHaveLength(2);
});
it("a zip, a pdf and a code file get cards that read nothing, the code file named as text, while a text file still previews", async () => {
  setup();
  files.listing = listed("q3.zip", "deck.pdf", "deploy.yaml", "notes.txt");
  await show([bot("b1", "`q3.zip`, `deck.pdf`, `deploy.yaml` and `notes.txt`")]);
  await answerNext("notes.txt", chunk("notes.txt", "text/plain", "Remember the release notes"));
  expect(card("notes.txt")?.textContent).toContain("Remember the release notes");
  expect(card("deploy.yaml")?.textContent).toContain("Text");
  expect(card("deploy.yaml")?.getAttribute("aria-label")).toBe("Open deploy.yaml, Text file");
  expect(card("q3.zip")?.textContent).toContain("File");
  expect(card("deck.pdf")?.textContent).toContain("File");
  expect(files.previews.map((entry) => entry.relativePath)).toEqual(["notes.txt"]);
});
